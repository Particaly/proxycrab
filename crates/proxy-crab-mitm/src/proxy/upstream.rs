use std::{collections::HashMap, fmt, str::FromStr, sync::Arc};

use anyhow::{Context, Result, anyhow, bail};
use hyper::{
    Request, Response, Uri, Version,
    body::Incoming,
    header::{HOST, UPGRADE},
};
use hyper_rustls::{HttpsConnector, HttpsConnectorBuilder};
use hyper_util::{
    client::legacy::{Client, connect::HttpConnector},
    rt::{TokioExecutor, TokioIo, TokioTimer},
};
use rustls::{
    ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{CryptoProvider, WebPkiSupportedAlgorithms},
    pki_types::{CertificateDer, ServerName, UnixTime},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
    sync::Mutex,
    time::timeout,
};
use tokio_rustls::TlsConnector;
use tokio_util::sync::CancellationToken;

use super::{CONNECT_TIMEOUT, ProxyBody};

type PooledHttp1Client = Client<HttpsConnector<HttpConnector>, ProxyBody>;
type H2Sender = hyper::client::conn::http2::SendRequest<ProxyBody>;

/// 连接目标失败类别：区分超时与直接失败，供调用方选择记录口径。
#[derive(Debug)]
pub(crate) enum ConnectTargetError {
    Timeout(anyhow::Error),
    Failed(anyhow::Error),
}

impl fmt::Display for ConnectTargetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Timeout(error) | Self::Failed(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for ConnectTargetError {}

/// 计算 `host:port` 连接目标，IPv6 主机补方括号。
fn authority_of(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// 连接目标 authority：未配置上游代理时直连；配置了则先与代理建立 CONNECT 隧道。
pub(crate) async fn connect_target(
    upstream: Option<&str>,
    authority: &str,
) -> std::result::Result<TcpStream, ConnectTargetError> {
    match upstream {
        None => match timeout(CONNECT_TIMEOUT, TcpStream::connect(authority)).await {
            Ok(Ok(stream)) => Ok(stream),
            Ok(Err(error)) => Err(ConnectTargetError::Failed(anyhow!(
                "upstream connect failed: {error}"
            ))),
            Err(_) => Err(ConnectTargetError::Timeout(anyhow!(
                "upstream connection timed out"
            ))),
        },
        Some(proxy) => {
            let mut stream = match timeout(CONNECT_TIMEOUT, TcpStream::connect(proxy)).await {
                Ok(Ok(stream)) => stream,
                Ok(Err(error)) => {
                    return Err(ConnectTargetError::Failed(anyhow!(
                        "upstream proxy {proxy} connect failed: {error}"
                    )));
                }
                Err(_) => {
                    return Err(ConnectTargetError::Timeout(anyhow!(
                        "upstream proxy {proxy} connection timed out"
                    )));
                }
            };
            establish_proxy_tunnel(&mut stream, proxy, authority).await?;
            Ok(stream)
        }
    }
}

/// 向上游代理发送 CONNECT 并等待 2xx，把连接变为到目标 authority 的隧道。
async fn establish_proxy_tunnel(
    stream: &mut TcpStream,
    proxy: &str,
    authority: &str,
) -> std::result::Result<(), ConnectTargetError> {
    let request = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n");
    if let Err(error) = stream.write_all(request.as_bytes()).await {
        return Err(ConnectTargetError::Failed(anyhow!(
            "upstream proxy {proxy} write failed: {error}"
        )));
    }
    let mut response = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match timeout(CONNECT_TIMEOUT, stream.read(&mut byte)).await {
            Ok(Ok(0)) => {
                return Err(ConnectTargetError::Failed(anyhow!(
                    "upstream proxy {proxy} closed the connection during CONNECT"
                )));
            }
            Ok(Ok(_)) => {
                response.push(byte[0]);
                if response.ends_with(b"\r\n\r\n") {
                    break;
                }
                if response.len() > 8192 {
                    return Err(ConnectTargetError::Failed(anyhow!(
                        "upstream proxy {proxy} CONNECT response header is too large"
                    )));
                }
            }
            Ok(Err(error)) => {
                return Err(ConnectTargetError::Failed(anyhow!(
                    "upstream proxy {proxy} read failed: {error}"
                )));
            }
            Err(_) => {
                return Err(ConnectTargetError::Timeout(anyhow!(
                    "upstream proxy {proxy} CONNECT response timed out"
                )));
            }
        }
    }
    let head = String::from_utf8_lossy(&response);
    let status = head.split_whitespace().nth(1).unwrap_or("");
    match status.parse::<u16>() {
        Ok(code) if (200..300).contains(&code) => Ok(()),
        Ok(code) => Err(ConnectTargetError::Failed(anyhow!(
            "upstream proxy {proxy} rejected CONNECT to {authority}: {code}"
        ))),
        Err(_) => Err(ConnectTargetError::Failed(anyhow!(
            "upstream proxy {proxy} returned an invalid CONNECT response"
        ))),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum UpstreamHttpVersion {
    Http1,
    Http2,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct H2PoolKey {
    scheme: String,
    authority: String,
    tls_insecure: bool,
    allow_http1_fallback: bool,
}

impl H2PoolKey {
    fn from_request(
        request: &Request<ProxyBody>,
        tls_insecure: bool,
        allow_http1_fallback: bool,
    ) -> Result<Self> {
        let uri = request.uri();
        Ok(Self {
            scheme: uri
                .scheme_str()
                .ok_or_else(|| anyhow!("upstream URI has no scheme"))?
                .to_owned(),
            authority: uri
                .authority()
                .ok_or_else(|| anyhow!("upstream URI has no authority"))?
                .as_str()
                .to_owned(),
            tls_insecure,
            allow_http1_fallback,
        })
    }
}

enum H2PoolState {
    Unknown,
    Http1,
    Http2(H2Sender),
}

#[derive(Default)]
struct H2Pool {
    origins: Mutex<HashMap<H2PoolKey, Arc<Mutex<H2PoolState>>>>,
}

impl H2Pool {
    async fn origin(&self, key: H2PoolKey) -> Arc<Mutex<H2PoolState>> {
        self.origins
            .lock()
            .await
            .entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(H2PoolState::Unknown)))
            .clone()
    }
}

#[derive(Clone)]
pub(crate) struct UpstreamClient {
    /// 出站上游代理（`host:port`），None 表示直连。
    upstream: Option<String>,
    verified: PooledHttp1Client,
    insecure: PooledHttp1Client,
    h2: Arc<H2Pool>,
}

impl UpstreamClient {
    pub(crate) fn new(upstream: Option<String>) -> Self {
        Self {
            upstream,
            verified: pooled_http1_client(client_config(false)),
            insecure: pooled_http1_client(client_config(true)),
            h2: Arc::new(H2Pool::default()),
        }
    }

    /// 当前的上游代理配置，供 CONNECT 隧道等旁路拨号点复用。
    pub(crate) fn upstream_proxy(&self) -> Option<String> {
        self.upstream.clone()
    }

    pub(crate) async fn send(
        &self,
        mut request: Request<ProxyBody>,
        tls_insecure: bool,
        http_version: Option<UpstreamHttpVersion>,
        cancellation: CancellationToken,
    ) -> Result<Response<Incoming>> {
        match http_version {
            Some(UpstreamHttpVersion::Http1) => *request.version_mut() = Version::HTTP_11,
            Some(UpstreamHttpVersion::Http2) => *request.version_mut() = Version::HTTP_2,
            None => {}
        }
        let tls_insecure = tls_insecure && request.uri().scheme_str() == Some("https");
        // 走上游代理时统一使用专用路径：CONNECT 隧道 + 显式 origin-form，
        // 不依赖池化客户端的转发语义；未配置时保持原有池化路径。
        if let Some(upstream) = self.upstream.clone() {
            return send_dedicated(
                request,
                tls_insecure,
                http_version,
                cancellation,
                Some(upstream.as_str()),
            )
            .await;
        }
        if request.headers().contains_key(UPGRADE) {
            return send_dedicated(request, tls_insecure, http_version, cancellation, None).await;
        }
        match http_version {
            Some(UpstreamHttpVersion::Http1) => {
                self.send_pooled_http1(request, tls_insecure, cancellation)
                    .await
            }
            Some(UpstreamHttpVersion::Http2) => {
                self.send_http2(request, tls_insecure, false, cancellation)
                    .await
            }
            None if request.version() == Version::HTTP_2 => {
                self.send_http2(request, tls_insecure, true, cancellation)
                    .await
            }
            None => {
                self.send_pooled_http1(request, tls_insecure, cancellation)
                    .await
            }
        }
    }

    async fn send_pooled_http1(
        &self,
        mut request: Request<ProxyBody>,
        tls_insecure: bool,
        cancellation: CancellationToken,
    ) -> Result<Response<Incoming>> {
        prepare_http1_request(&mut request)?;
        let client = if tls_insecure {
            &self.insecure
        } else {
            &self.verified
        };
        tokio::select! {
            response = client.request(request) => Ok(response?),
            _ = cancellation.cancelled() => bail!("proxy stopped"),
        }
    }

    async fn send_http2(
        &self,
        request: Request<ProxyBody>,
        tls_insecure: bool,
        allow_http1_fallback: bool,
        cancellation: CancellationToken,
    ) -> Result<Response<Incoming>> {
        let key = H2PoolKey::from_request(&request, tls_insecure, allow_http1_fallback)?;
        let origin = self.h2.origin(key).await;
        let mut state = origin.lock().await;

        if matches!(&*state, H2PoolState::Http1) {
            drop(state);
            if allow_http1_fallback {
                return self
                    .send_pooled_http1(request, tls_insecure, cancellation)
                    .await;
            }
            bail!("upstream did not negotiate HTTP/2");
        }
        if let H2PoolState::Http2(sender) = &*state
            && !sender.is_closed()
        {
            let sender = sender.clone();
            drop(state);
            return send_with_h2_sender(sender, request, cancellation).await;
        }

        let uri = request.uri().clone();
        let host = uri
            .host()
            .ok_or_else(|| anyhow!("upstream URI has no host"))?;
        let https = uri.scheme_str() == Some("https");
        let port = uri.port_u16().unwrap_or(if https { 443 } else { 80 });
        let stream = timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port)))
            .await
            .context("upstream connect timeout")??;

        if https {
            let mut config = client_config(tls_insecure);
            config.alpn_protocols = if allow_http1_fallback {
                vec![b"h2".to_vec(), b"http/1.1".to_vec()]
            } else {
                vec![b"h2".to_vec()]
            };
            let connector = TlsConnector::from(Arc::new(config));
            let server_name = ServerName::try_from(host.to_string())
                .map_err(|error| anyhow!("invalid TLS server name: {error}"))?;
            let tls = connector.connect(server_name, stream).await?;
            if tls.get_ref().1.alpn_protocol() == Some(b"h2") {
                let sender = establish_h2(tls, cancellation.clone()).await?;
                *state = H2PoolState::Http2(sender.clone());
                drop(state);
                send_with_h2_sender(sender, request, cancellation).await
            } else if allow_http1_fallback {
                *state = H2PoolState::Http1;
                drop(state);
                send_http1_on_io(tls, request, cancellation).await
            } else {
                bail!("upstream did not negotiate HTTP/2")
            }
        } else {
            let sender = establish_h2(stream, cancellation.clone()).await?;
            *state = H2PoolState::Http2(sender.clone());
            drop(state);
            send_with_h2_sender(sender, request, cancellation).await
        }
    }
}

fn pooled_http1_client(config: ClientConfig) -> PooledHttp1Client {
    let mut http = HttpConnector::new();
    http.enforce_http(false);
    http.set_connect_timeout(Some(CONNECT_TIMEOUT));
    let https = HttpsConnectorBuilder::new()
        .with_tls_config(config)
        .https_or_http()
        .enable_http1()
        .wrap_connector(http);
    Client::builder(TokioExecutor::new())
        .pool_idle_timeout(std::time::Duration::from_secs(90))
        .pool_timer(TokioTimer::new())
        .pool_max_idle_per_host(32)
        .build(https)
}

fn client_config(tls_insecure: bool) -> ClientConfig {
    let roots = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let mut config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    if tls_insecure {
        let algorithms = CryptoProvider::get_default()
            .expect("rustls crypto provider is installed by ClientConfig::builder")
            .signature_verification_algorithms;
        config
            .dangerous()
            .set_certificate_verifier(Arc::new(InsecureServerCertVerifier { algorithms }));
    }
    config
}

#[derive(Debug)]
struct InsecureServerCertVerifier {
    algorithms: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for InsecureServerCertVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

async fn send_dedicated(
    request: Request<ProxyBody>,
    tls_insecure: bool,
    http_version: Option<UpstreamHttpVersion>,
    cancellation: CancellationToken,
    upstream: Option<&str>,
) -> Result<Response<Incoming>> {
    let uri = request.uri().clone();
    let host = uri
        .host()
        .ok_or_else(|| anyhow!("upstream URI has no host"))?;
    let https = uri.scheme_str() == Some("https");
    let port = uri.port_u16().unwrap_or(if https { 443 } else { 80 });
    let stream = connect_target(upstream, &authority_of(host, port)).await?;
    if https {
        let mut config = client_config(tls_insecure);
        config.alpn_protocols = match http_version {
            Some(UpstreamHttpVersion::Http1) => vec![b"http/1.1".to_vec()],
            Some(UpstreamHttpVersion::Http2) => vec![b"h2".to_vec()],
            None => vec![b"h2".to_vec(), b"http/1.1".to_vec()],
        };
        let connector = TlsConnector::from(Arc::new(config));
        let server_name = ServerName::try_from(host.to_string())
            .map_err(|error| anyhow!("invalid TLS server name: {error}"))?;
        let tls = connector.connect(server_name, stream).await?;
        let negotiated_http2 = tls.get_ref().1.alpn_protocol() == Some(b"h2");
        if http_version == Some(UpstreamHttpVersion::Http2) && !negotiated_http2 {
            bail!("upstream did not negotiate HTTP/2");
        }
        let use_http2 = match http_version {
            Some(UpstreamHttpVersion::Http1) => false,
            Some(UpstreamHttpVersion::Http2) => true,
            None => negotiated_http2,
        };
        send_on_io(tls, request, use_http2, cancellation).await
    } else {
        let use_http2 = match http_version {
            Some(UpstreamHttpVersion::Http1) => false,
            Some(UpstreamHttpVersion::Http2) => true,
            None => request.version() == Version::HTTP_2,
        };
        send_on_io(stream, request, use_http2, cancellation).await
    }
}

async fn send_on_io<T>(
    stream: T,
    request: Request<ProxyBody>,
    use_http2: bool,
    cancellation: CancellationToken,
) -> Result<Response<Incoming>>
where
    T: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    if use_http2 {
        let sender = establish_h2(stream, cancellation.clone()).await?;
        send_with_h2_sender(sender, request, cancellation).await
    } else {
        send_http1_on_io(stream, request, cancellation).await
    }
}

async fn establish_h2<T>(stream: T, cancellation: CancellationToken) -> Result<H2Sender>
where
    T: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (sender, connection) = hyper::client::conn::http2::Builder::new(TokioExecutor::new())
        .handshake(TokioIo::new(stream))
        .await?;
    tokio::spawn(async move {
        tokio::select! {
            result = connection => {
                if let Err(error) = result {
                    tracing::warn!("HTTP/2 upstream connection failed: {error}");
                }
            }
            _ = cancellation.cancelled() => {}
        }
    });
    Ok(sender)
}

async fn send_with_h2_sender(
    mut sender: H2Sender,
    mut request: Request<ProxyBody>,
    cancellation: CancellationToken,
) -> Result<Response<Incoming>> {
    *request.version_mut() = Version::HTTP_2;
    request.headers_mut().remove(HOST);
    tokio::select! {
        response = sender.send_request(request) => Ok(response?),
        _ = cancellation.cancelled() => bail!("proxy stopped"),
    }
}

fn prepare_http1_request(request: &mut Request<ProxyBody>) -> Result<()> {
    if request.version() == Version::HTTP_2 {
        *request.version_mut() = Version::HTTP_11;
    }
    if !request.headers().contains_key(HOST) {
        let host = request
            .uri()
            .authority()
            .ok_or_else(|| anyhow!("upstream URI has no authority"))?
            .as_str()
            .parse()?;
        request.headers_mut().insert(HOST, host);
    }
    Ok(())
}

async fn send_http1_on_io<T>(
    stream: T,
    mut request: Request<ProxyBody>,
    cancellation: CancellationToken,
) -> Result<Response<Incoming>>
where
    T: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    prepare_http1_request(&mut request)?;
    let origin = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");
    *request.uri_mut() = Uri::from_str(origin)?;
    let (mut sender, connection) =
        hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
    tokio::spawn(async move {
        tokio::select! {
            result = connection.with_upgrades() => {
                if let Err(error) = result {
                    tracing::warn!("HTTP/1 upstream connection failed: {error}");
                }
            }
            _ = cancellation.cancelled() => {}
        }
    });
    Ok(sender.send_request(request).await?)
}

#[cfg(test)]
mod tests {
    use std::{
        convert::Infallible,
        net::SocketAddr,
        sync::{
            Arc, Mutex as StdMutex,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };

    use bytes::Bytes;
    use http_body_util::{BodyExt, Full};
    use hyper::{
        Request, Response, StatusCode,
        header::{CONNECTION, HOST, UPGRADE},
        server::conn::{http1, http2},
        service::service_fn,
    };
    use hyper_util::rt::{TokioExecutor, TokioIo};
    use rcgen::{CertifiedKey, generate_simple_self_signed};
    use rustls::{
        ServerConfig,
        pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer},
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        sync::{mpsc, oneshot},
        time::timeout,
    };
    use tokio_rustls::TlsAcceptor;
    use tokio_util::sync::CancellationToken;

    use super::{H2PoolKey, H2PoolState, UpstreamClient, UpstreamHttpVersion, connect_target};
    use crate::proxy::boxed_full;

    #[tokio::test]
    async fn reuses_http1_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let accepted = Arc::new(AtomicUsize::new(0));
        let accepted_by_server = accepted.clone();
        let (stop_tx, mut stop_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut stop_rx => break,
                    accepted = listener.accept() => {
                        let (stream, _) = accepted.unwrap();
                        accepted_by_server.fetch_add(1, Ordering::Relaxed);
                        tokio::spawn(async move {
                            let service = service_fn(|_| async {
                                Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(b"ok"))))
                            });
                            let _ = http1::Builder::new()
                                .serve_connection(TokioIo::new(stream), service)
                                .await;
                        });
                    }
                }
            }
        });

        let client = UpstreamClient::new(None);
        for _ in 0..2 {
            let request = Request::builder()
                .uri(format!("http://{address}/"))
                .body(boxed_full(Bytes::new()))
                .unwrap();
            let response = client
                .send(request, false, None, CancellationToken::new())
                .await
                .unwrap();
            assert_eq!(
                response.into_body().collect().await.unwrap().to_bytes(),
                Bytes::from_static(b"ok")
            );
        }

        assert_eq!(accepted.load(Ordering::Relaxed), 1);
        let _ = stop_tx.send(());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn http1_override_sets_exact_version() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                stream.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
            }
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
            request
        });
        let request = Request::builder()
            .uri(format!("http://{address}/downgraded"))
            .version(hyper::Version::HTTP_10)
            .body(boxed_full(Bytes::new()))
            .unwrap();

        let response = UpstreamClient::new(None)
            .send(
                request,
                false,
                Some(UpstreamHttpVersion::Http1),
                CancellationToken::new(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let request = server.await.unwrap();
        assert!(request.starts_with(b"GET /downgraded HTTP/1.1\r\n"));
    }

    #[tokio::test]
    async fn http2_override_upgrades_http1_request() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (version_tx, mut version_rx) = mpsc::unbounded_channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let service = service_fn(move |request: Request<hyper::body::Incoming>| {
                let _ = version_tx.send(request.version());
                async { Ok::<_, Infallible>(Response::new(Full::new(Bytes::new()))) }
            });
            let _ = http2::Builder::new(TokioExecutor::new())
                .serve_connection(TokioIo::new(stream), service)
                .await;
        });
        let request = Request::builder()
            .uri(format!("http://{address}/upgraded"))
            .version(hyper::Version::HTTP_11)
            .body(boxed_full(Bytes::new()))
            .unwrap();

        let response = UpstreamClient::new(None)
            .send(
                request,
                false,
                Some(UpstreamHttpVersion::Http2),
                CancellationToken::new(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(version_rx.recv().await.unwrap(), hyper::Version::HTTP_2);
        server.abort();
    }

    #[tokio::test]
    async fn dedicated_https_upgrade_honors_insecure_tls_policy() {
        let CertifiedKey { cert, signing_key } =
            generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap();
        let config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![cert.der().clone()],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(signing_key.serialize_der())),
            )
            .unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut tls = acceptor.accept(stream).await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                tls.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
            }
            tls.write_all(
                b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
            )
            .await
            .unwrap();
        });

        let request = Request::builder()
            .uri(format!("https://{address}/upgrade"))
            .version(hyper::Version::HTTP_2)
            .header(CONNECTION, "upgrade")
            .header(UPGRADE, "websocket")
            .body(boxed_full(Bytes::new()))
            .unwrap();
        let response = UpstreamClient::new(None)
            .send(
                request,
                true,
                Some(UpstreamHttpVersion::Http1),
                CancellationToken::new(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn https_http2_reuses_connection_and_reconnects_after_close() {
        let CertifiedKey { cert, signing_key } =
            generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap();
        let mut config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![cert.der().clone()],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(signing_key.serialize_der())),
            )
            .unwrap();
        config.alpn_protocols = vec![b"h2".to_vec()];
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let accepted = Arc::new(AtomicUsize::new(0));
        let accepted_by_server = accepted.clone();
        let (closed_tx, mut closed_rx) = mpsc::unbounded_channel();
        let (stop_tx, mut stop_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut stop_rx => break,
                    accepted = listener.accept() => {
                        let (stream, _) = accepted.unwrap();
                        accepted_by_server.fetch_add(1, Ordering::Relaxed);
                        let acceptor = acceptor.clone();
                        let closed_tx = closed_tx.clone();
                        tokio::spawn(async move {
                            let tls = acceptor.accept(stream).await.unwrap();
                            let requests = Arc::new(AtomicUsize::new(0));
                            let (shutdown_tx, mut shutdown_rx) = oneshot::channel();
                            let shutdown_tx = Arc::new(StdMutex::new(Some(shutdown_tx)));
                            let service = service_fn(
                                move |request: Request<hyper::body::Incoming>| {
                                    let requests = requests.clone();
                                    let shutdown_tx = shutdown_tx.clone();
                                    async move {
                                    let valid_authority = request.uri().authority().is_some_and(
                                        |authority| authority.as_str() == address.to_string(),
                                    );
                                    let status = if valid_authority
                                        && !request.headers().contains_key(HOST)
                                    {
                                        StatusCode::OK
                                    } else {
                                        StatusCode::BAD_REQUEST
                                    };
                                    if requests.fetch_add(1, Ordering::Relaxed) + 1 == 2
                                        && let Some(shutdown_tx) = shutdown_tx
                                            .lock()
                                            .expect("shutdown lock poisoned")
                                            .take()
                                    {
                                        let _ = shutdown_tx.send(());
                                    }
                                    Ok::<_, Infallible>(
                                        Response::builder()
                                            .status(status)
                                            .body(Full::new(Bytes::new()))
                                            .unwrap(),
                                    )
                                    }
                                },
                            );
                            let connection = http2::Builder::new(TokioExecutor::new())
                                .serve_connection(TokioIo::new(tls), service);
                            tokio::pin!(connection);
                            tokio::select! {
                                _ = &mut connection => {}
                                _ = &mut shutdown_rx => {
                                    connection.as_mut().graceful_shutdown();
                                    let _ = connection.await;
                                }
                            }
                            let _ = closed_tx.send(());
                        });
                    }
                }
            }
        });

        let client = UpstreamClient::new(None);
        let send = |client: UpstreamClient| async move {
            let request = Request::builder()
                .uri(format!("https://{address}/strict-h2"))
                .version(hyper::Version::HTTP_2)
                .header(HOST, address.to_string())
                .body(boxed_full(Bytes::new()))
                .unwrap();
            client
                .send(request, true, None, CancellationToken::new())
                .await
        };
        let (first, second) = tokio::join!(send(client.clone()), send(client.clone()));

        for response in [first.unwrap(), second.unwrap()] {
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.version(), hyper::Version::HTTP_2);
            response.into_body().collect().await.unwrap();
        }

        closed_rx.recv().await.unwrap();
        let origin = client
            .h2
            .origin(H2PoolKey {
                scheme: "https".to_owned(),
                authority: address.to_string(),
                tls_insecure: true,
                allow_http1_fallback: true,
            })
            .await;
        timeout(Duration::from_secs(1), async {
            loop {
                let closed = match &*origin.lock().await {
                    H2PoolState::Http2(sender) => sender.is_closed(),
                    _ => false,
                };
                if closed {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        let response = send(client.clone()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.version(), hyper::Version::HTTP_2);
        response.into_body().collect().await.unwrap();

        assert_eq!(accepted.load(Ordering::Relaxed), 2);
        drop(client);
        let _ = stop_tx.send(());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn https_http2_caches_http1_alpn_fallback() {
        let CertifiedKey { cert, signing_key } =
            generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap();
        let mut config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![cert.der().clone()],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(signing_key.serialize_der())),
            )
            .unwrap();
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let accepted = Arc::new(AtomicUsize::new(0));
        let accepted_by_server = accepted.clone();
        let (stop_tx, mut stop_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut stop_rx => break,
                    accepted = listener.accept() => {
                        let (stream, _) = accepted.unwrap();
                        accepted_by_server.fetch_add(1, Ordering::Relaxed);
                        let acceptor = acceptor.clone();
                        tokio::spawn(async move {
                            let tls = acceptor.accept(stream).await.unwrap();
                            let service = service_fn(
                                |request: Request<hyper::body::Incoming>| async move {
                                    let valid = request.version() == hyper::Version::HTTP_11
                                        && request.uri().authority().is_none()
                                        && request.headers().contains_key(HOST);
                                    Ok::<_, Infallible>(
                                        Response::builder()
                                            .status(if valid {
                                                StatusCode::OK
                                            } else {
                                                StatusCode::BAD_REQUEST
                                            })
                                            .body(Full::new(Bytes::new()))
                                            .unwrap(),
                                    )
                                },
                            );
                            let _ = http1::Builder::new()
                                .serve_connection(TokioIo::new(tls), service)
                                .await;
                        });
                    }
                }
            }
        });

        let client = UpstreamClient::new(None);
        for _ in 0..3 {
            let request = Request::builder()
                .uri(format!("https://{address}/h1-fallback"))
                .version(hyper::Version::HTTP_2)
                .header(HOST, address.to_string())
                .body(boxed_full(Bytes::new()))
                .unwrap();
            let response = client
                .send(request, true, None, CancellationToken::new())
                .await
                .unwrap();

            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.version(), hyper::Version::HTTP_11);
            response.into_body().collect().await.unwrap();
        }

        assert_eq!(accepted.load(Ordering::Relaxed), 2);

        let request = Request::builder()
            .uri(format!("https://{address}/strict-h2"))
            .version(hyper::Version::HTTP_2)
            .body(boxed_full(Bytes::new()))
            .unwrap();
        assert!(
            client
                .send(
                    request,
                    true,
                    Some(UpstreamHttpVersion::Http2),
                    CancellationToken::new(),
                )
                .await
                .is_err(),
            "forced HTTP/2 must not fall back to HTTP/1.1"
        );

        drop(client);
        let _ = stop_tx.send(());
        server.await.unwrap();
    }

    /// 起一个假 HTTP 代理：收到 CONNECT 后校验请求行，回复 `response`；
    /// 若回复为 2xx，则继续把连接转接到请求行里的 authority 并双向拷贝。
    async fn spawn_fake_proxy(response: &'static [u8]) -> (SocketAddr, oneshot::Receiver<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = oneshot::channel();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut byte = [0u8; 1];
            while !request.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
            }
            let authority = String::from_utf8_lossy(&request)
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or_default()
                .to_owned();
            let _ = request_tx.send(request);
            stream.write_all(response).await.unwrap();
            if response.starts_with(b"HTTP/1.1 200") && !authority.is_empty() {
                let mut target = TcpStream::connect(authority).await.unwrap();
                let _ = tokio::io::copy_bidirectional(&mut stream, &mut target).await;
            }
        });
        (address, request_rx)
    }

    #[tokio::test]
    async fn connect_target_builds_proxy_tunnel_and_forwards_traffic() {
        // 目标 HTTP 服务。
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let service = service_fn(|_| async {
                Ok::<_, Infallible>(Response::new(Full::new(Bytes::from_static(b"via-proxy"))))
            });
            let _ = http1::Builder::new()
                .serve_connection(TokioIo::new(listener.accept().await.unwrap().0), service)
                .await;
        });

        let (proxy_address, request_rx) =
            spawn_fake_proxy(b"HTTP/1.1 200 Connection Established\r\n\r\n").await;
        let client = UpstreamClient::new(Some(proxy_address.to_string()));
        let request = Request::builder()
            .uri(format!("http://{target_address}/"))
            .body(boxed_full(Bytes::new()))
            .unwrap();
        let response = client
            .send(request, false, None, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(
            response.into_body().collect().await.unwrap().to_bytes(),
            Bytes::from_static(b"via-proxy")
        );

        let request = request_rx.await.unwrap();
        let head = String::from_utf8(request).unwrap();
        let request_line = head.lines().next().unwrap();
        assert_eq!(
            request_line,
            format!("CONNECT {target_address} HTTP/1.1"),
            "代理必须收到 CONNECT authority 请求行"
        );
        server.abort();
    }

    #[tokio::test]
    async fn connect_target_reports_rejected_tunnel() {
        let (proxy_address, _request_rx) =
            spawn_fake_proxy(b"HTTP/1.1 403 Forbidden\r\n\r\n").await;
        let error = connect_target(Some(&proxy_address.to_string()), "example.com:443")
            .await
            .expect_err("非 2xx 隧道响应必须报错");
        assert!(error.to_string().contains("403"), "{error}");
    }

    #[tokio::test]
    async fn connect_target_dials_directly_without_upstream() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let _connection = listener.accept().await.unwrap();
        });
        connect_target(None, &address.to_string())
            .await
            .expect("直连目标应当成功");
        server.await.unwrap();
    }
}
