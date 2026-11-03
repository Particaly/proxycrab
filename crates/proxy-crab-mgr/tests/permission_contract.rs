use std::collections::BTreeSet;

use proxy_crab_mgr::permission::{
    PermissionMode, api_actions, api_actions_for_path, find_api_action,
};

fn action_ids(mode: PermissionMode) -> BTreeSet<&'static str> {
    api_actions()
        .iter()
        .filter(|action| action.default_mode == mode)
        .map(|action| action.id)
        .collect()
}

#[test]
fn permission_catalog_contains_every_unique_route_action() {
    let actions = api_actions();
    let ids = actions
        .iter()
        .map(|action| action.id)
        .collect::<BTreeSet<_>>();

    assert_eq!(actions.len(), 100);
    assert_eq!(ids.len(), actions.len());
    assert!(
        actions
            .iter()
            .all(|action| { action.id == format!("{} {}", action.method, action.route_template) })
    );
    assert!(actions.iter().all(|action| !action.method.is_empty()));
    assert!(
        actions
            .iter()
            .all(|action| !action.route_template.is_empty())
    );
}

#[test]
fn permission_catalog_has_the_confirmed_default_matrix() {
    let allow = BTreeSet::from([
        "GET /api/redaction-scripts",
        "POST /api/redaction-scripts",
        "GET /api/agents.md",
        "GET /api/archived-sessions",
        "GET /api/assets",
        "GET /api/assets/{*asset_id}",
        "GET /api/breakpoints",
        "GET /api/breakpoints/{id}",
        "GET /api/breakpoints/{id}/body",
        "GET /api/bypass",
        "GET /api/column-scripts",
        "GET /api/column-scripts/{name}",
        "GET /api/config",
        "GET /api/clash-subscription",
        "GET /api/clash-config",
        "PUT /api/clash-config",
        "DELETE /api/clash-config",
        "GET /api/filter-scripts",
        "GET /api/filter-scripts/{name}",
        "GET /api/flow-projects",
        "GET /api/flow-projects/{id}",
        "GET /api/interceptors",
        "GET /api/interceptors/{kind}/{name}",
        "GET /api/logs/{id}",
        "GET /api/logs/{id}/body",
        "GET /api/logs/{id}/websocket/messages",
        "GET /api/logs/{id}/websocket/messages/{message_id}/body",
        "GET /api/logs/{id}/interceptors/{execution_id}/content",
        "GET /api/logs/{id}/interceptors/{execution_id}/snapshot",
        "GET /api/proxy/status",
        "GET /api/request-library",
        "GET /api/request-library/{id}",
        "GET /api/request-library/{id}/body",
        "GET /api/routing-script-selection",
        "GET /api/routing-scripts",
        "GET /api/routing-scripts/{name}",
        "GET /api/session-interceptors",
        "GET /api/session-shares",
        "GET /api/session-shares/{id}",
        "GET /api/session-view",
        "GET /api/sessions",
        "GET /api/system-logs",
        "GET /api/workflows",
        "GET /api/workflows/{id}",
        "POST /api/filter-scripts/{name}/debug",
        "POST /api/logs/ids",
        "POST /api/logs/views",
        "POST /api/replay",
        "POST /api/workflows/{id}/validate",
    ]);
    let approval = BTreeSet::from([
        "PUT /api/redaction-scripts/{name}",
        "DELETE /api/redaction-scripts/{name}",
        "PUT /api/clash-subscription",
        "DELETE /api/clash-subscription",
        "POST /api/archived-sessions/{id}/restore",
        "POST /api/assets/{*asset_id}",
        "POST /api/breakpoints/{id}/execute",
        "POST /api/breakpoints/{id}/extend",
        "POST /api/breakpoints/{id}/release",
        "POST /api/column-scripts",
        "POST /api/filter-scripts",
        "POST /api/imports",
        "POST /api/imports/{id}/resolve",
        "POST /api/interceptors",
        "POST /api/proxy/start",
        "POST /api/proxy/stop",
        "POST /api/request-library",
        "POST /api/request-library/from-capture",
        "POST /api/routing-scripts",
        "POST /api/session-shares",
        "POST /api/sessions",
        "PUT /api/active-session",
        "PUT /api/column-scripts/{name}",
        "PUT /api/filter-scripts/{name}",
        "PUT /api/interceptors/{kind}/{name}",
        "PUT /api/request-library/{id}",
        "PUT /api/routing-script-selection",
        "PUT /api/routing-scripts/{name}",
        "PUT /api/session-interceptors",
        "PUT /api/session-view",
        "PUT /api/sessions/{id}",
        "PUT /api/sessions/{id}/filter",
        "DELETE /api/flow-projects/{id}",
        "DELETE /api/workflows/{id}",
        "DELETE /api/request-library/{id}",
        "DELETE /api/session-shares/{id}",
        "POST /api/flow-projects",
        "POST /api/workflows",
        "PUT /api/flow-projects/{id}",
        "PUT /api/workflows/{id}",
    ]);
    let deny = BTreeSet::from([
        "GET /api/redaction-scripts/{name}",
        "DELETE /api/archived-sessions/{id}",
        "DELETE /api/bypass",
        "DELETE /api/bypass/{id}",
        "DELETE /api/column-scripts/{name}",
        "DELETE /api/filter-scripts/{name}",
        "DELETE /api/interceptors/{kind}/{name}",
        "DELETE /api/routing-scripts/{name}",
        "DELETE /api/system-logs",
        "POST /api/bypass/delete",
        "POST /api/sessions/{id}/archive",
    ]);

    assert_eq!(action_ids(PermissionMode::Allow), allow);
    assert_eq!(action_ids(PermissionMode::Approval), approval);
    assert_eq!(action_ids(PermissionMode::Deny), deny);
}

#[test]
fn permission_lookup_uses_both_method_and_route_template() {
    assert_eq!(
        find_api_action("POST", "/api/filter-scripts/{name}/debug")
            .unwrap()
            .default_mode,
        PermissionMode::Allow
    );
    assert_eq!(
        find_api_action("POST", "/api/breakpoints/{id}/release")
            .unwrap()
            .default_mode,
        PermissionMode::Approval
    );
    assert!(find_api_action("GET", "/api/ca").is_none());
    assert!(find_api_action("GET", "/ca.crt").is_none());
    assert!(find_api_action("POST", "/api/ca").is_none());
    assert!(find_api_action("PUT", "/api/config").is_none());
    assert!(find_api_action("PUT", "/api/workspace").is_none());
    assert!(find_api_action("GET", "/api/workspace").is_none());
    assert!(find_api_action("GET", "/api/active-session").is_none());
    assert!(find_api_action("POST", "/api/session-har-shares").is_none());
    assert!(find_api_action("GET", "/api/session-har-shares/{id}").is_none());
    assert!(find_api_action("DELETE", "/api/session-har-shares/{id}").is_none());
    assert!(find_api_action("POST", "/api/logs/export").is_none());
    assert_eq!(
        find_api_action("POST", "/api/session-shares")
            .unwrap()
            .default_mode,
        PermissionMode::Approval
    );
    assert_eq!(
        find_api_action("GET", "/api/session-shares/{id}")
            .unwrap()
            .default_mode,
        PermissionMode::Allow
    );
    assert_eq!(
        find_api_action("DELETE", "/api/session-shares/{id}")
            .unwrap()
            .default_mode,
        PermissionMode::Approval
    );
    // Workflow domain: reads (and the read-only graph validation executed via
    // POST) default to allow; definition writes default to approval.
    assert_eq!(
        find_api_action("POST", "/api/workflows/{id}/validate")
            .unwrap()
            .default_mode,
        PermissionMode::Allow
    );
    assert_eq!(
        find_api_action("GET", "/api/flow-projects/{id}")
            .unwrap()
            .default_mode,
        PermissionMode::Allow
    );
    assert_eq!(
        find_api_action("POST", "/api/workflows")
            .unwrap()
            .default_mode,
        PermissionMode::Approval
    );
    assert_eq!(
        find_api_action("PUT", "/api/workflows/{id}")
            .unwrap()
            .default_mode,
        PermissionMode::Approval
    );
    assert_eq!(
        find_api_action("DELETE", "/api/flow-projects/{id}")
            .unwrap()
            .default_mode,
        PermissionMode::Approval
    );
    assert!(find_api_action("PATCH", "/api/workflows/{id}").is_none());
    assert!(find_api_action("DELETE", "/api/ca").is_none());
    assert!(find_api_action("GET", "/api/logs/123").is_none());

    // Request library (plan Task 6): reads allow, writes and deletes approval.
    let request_library_modes = [
        ("GET", "/api/request-library", PermissionMode::Allow),
        ("POST", "/api/request-library", PermissionMode::Approval),
        ("GET", "/api/request-library/{id}", PermissionMode::Allow),
        ("PUT", "/api/request-library/{id}", PermissionMode::Approval),
        (
            "DELETE",
            "/api/request-library/{id}",
            PermissionMode::Approval,
        ),
        (
            "POST",
            "/api/request-library/from-capture",
            PermissionMode::Approval,
        ),
        (
            "GET",
            "/api/request-library/{id}/body",
            PermissionMode::Allow,
        ),
    ];
    for (method, route, mode) in request_library_modes {
        assert_eq!(
            find_api_action(method, route).unwrap().default_mode,
            mode,
            "{method} {route}"
        );
    }

    let methods = api_actions_for_path("/api/column-scripts/example")
        .map(|action| action.method)
        .collect::<BTreeSet<_>>();
    assert_eq!(methods, BTreeSet::from(["DELETE", "GET", "PUT"]));
    let workflow_methods = api_actions_for_path("/api/workflows/wf-example")
        .map(|action| action.method)
        .collect::<BTreeSet<_>>();
    assert_eq!(workflow_methods, BTreeSet::from(["DELETE", "GET", "PUT"]));
    let validate_methods = api_actions_for_path("/api/workflows/wf-example/validate")
        .map(|action| action.method)
        .collect::<BTreeSet<_>>();
    assert_eq!(validate_methods, BTreeSet::from(["POST"]));
    let request_library_methods = api_actions_for_path("/api/request-library/entry-1")
        .map(|action| action.method)
        .collect::<BTreeSet<_>>();
    assert_eq!(
        request_library_methods,
        BTreeSet::from(["DELETE", "GET", "PUT"])
    );
    let body_methods = api_actions_for_path("/api/request-library/entry-1/body")
        .map(|action| action.method)
        .collect::<BTreeSet<_>>();
    assert_eq!(body_methods, BTreeSet::from(["GET"]));
    assert_eq!(api_actions_for_path("/api/not-found").count(), 0);
}
