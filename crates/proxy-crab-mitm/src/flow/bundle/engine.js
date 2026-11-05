"use strict";
var __flowEngine = (() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // node_modules/.pnpm/jmespath@0.16.0/node_modules/jmespath/jmespath.js
  var require_jmespath = __commonJS({
    "node_modules/.pnpm/jmespath@0.16.0/node_modules/jmespath/jmespath.js"(exports) {
      (function(exports2) {
        "use strict";
        function isArray(obj) {
          if (obj !== null) {
            return Object.prototype.toString.call(obj) === "[object Array]";
          } else {
            return false;
          }
        }
        function isObject(obj) {
          if (obj !== null) {
            return Object.prototype.toString.call(obj) === "[object Object]";
          } else {
            return false;
          }
        }
        function strictDeepEqual(first, second) {
          if (first === second) {
            return true;
          }
          var firstType = Object.prototype.toString.call(first);
          if (firstType !== Object.prototype.toString.call(second)) {
            return false;
          }
          if (isArray(first) === true) {
            if (first.length !== second.length) {
              return false;
            }
            for (var i = 0; i < first.length; i++) {
              if (strictDeepEqual(first[i], second[i]) === false) {
                return false;
              }
            }
            return true;
          }
          if (isObject(first) === true) {
            var keysSeen = {};
            for (var key in first) {
              if (hasOwnProperty.call(first, key)) {
                if (strictDeepEqual(first[key], second[key]) === false) {
                  return false;
                }
                keysSeen[key] = true;
              }
            }
            for (var key2 in second) {
              if (hasOwnProperty.call(second, key2)) {
                if (keysSeen[key2] !== true) {
                  return false;
                }
              }
            }
            return true;
          }
          return false;
        }
        function isFalse(obj) {
          if (obj === "" || obj === false || obj === null) {
            return true;
          } else if (isArray(obj) && obj.length === 0) {
            return true;
          } else if (isObject(obj)) {
            for (var key in obj) {
              if (obj.hasOwnProperty(key)) {
                return false;
              }
            }
            return true;
          } else {
            return false;
          }
        }
        function objValues(obj) {
          var keys = Object.keys(obj);
          var values = [];
          for (var i = 0; i < keys.length; i++) {
            values.push(obj[keys[i]]);
          }
          return values;
        }
        function merge(a, b) {
          var merged = {};
          for (var key in a) {
            merged[key] = a[key];
          }
          for (var key2 in b) {
            merged[key2] = b[key2];
          }
          return merged;
        }
        var trimLeft;
        if (typeof String.prototype.trimLeft === "function") {
          trimLeft = function(str) {
            return str.trimLeft();
          };
        } else {
          trimLeft = function(str) {
            return str.match(/^\s*(.*)/)[1];
          };
        }
        var TYPE_NUMBER = 0;
        var TYPE_ANY = 1;
        var TYPE_STRING = 2;
        var TYPE_ARRAY = 3;
        var TYPE_OBJECT = 4;
        var TYPE_BOOLEAN = 5;
        var TYPE_EXPREF = 6;
        var TYPE_NULL = 7;
        var TYPE_ARRAY_NUMBER = 8;
        var TYPE_ARRAY_STRING = 9;
        var TYPE_NAME_TABLE = {
          0: "number",
          1: "any",
          2: "string",
          3: "array",
          4: "object",
          5: "boolean",
          6: "expression",
          7: "null",
          8: "Array<number>",
          9: "Array<string>"
        };
        var TOK_EOF = "EOF";
        var TOK_UNQUOTEDIDENTIFIER = "UnquotedIdentifier";
        var TOK_QUOTEDIDENTIFIER = "QuotedIdentifier";
        var TOK_RBRACKET = "Rbracket";
        var TOK_RPAREN = "Rparen";
        var TOK_COMMA = "Comma";
        var TOK_COLON = "Colon";
        var TOK_RBRACE = "Rbrace";
        var TOK_NUMBER = "Number";
        var TOK_CURRENT = "Current";
        var TOK_EXPREF = "Expref";
        var TOK_PIPE = "Pipe";
        var TOK_OR = "Or";
        var TOK_AND = "And";
        var TOK_EQ = "EQ";
        var TOK_GT = "GT";
        var TOK_LT = "LT";
        var TOK_GTE = "GTE";
        var TOK_LTE = "LTE";
        var TOK_NE = "NE";
        var TOK_FLATTEN = "Flatten";
        var TOK_STAR = "Star";
        var TOK_FILTER = "Filter";
        var TOK_DOT = "Dot";
        var TOK_NOT = "Not";
        var TOK_LBRACE = "Lbrace";
        var TOK_LBRACKET = "Lbracket";
        var TOK_LPAREN = "Lparen";
        var TOK_LITERAL = "Literal";
        var basicTokens = {
          ".": TOK_DOT,
          "*": TOK_STAR,
          ",": TOK_COMMA,
          ":": TOK_COLON,
          "{": TOK_LBRACE,
          "}": TOK_RBRACE,
          "]": TOK_RBRACKET,
          "(": TOK_LPAREN,
          ")": TOK_RPAREN,
          "@": TOK_CURRENT
        };
        var operatorStartToken = {
          "<": true,
          ">": true,
          "=": true,
          "!": true
        };
        var skipChars = {
          " ": true,
          "	": true,
          "\n": true
        };
        function isAlpha(ch) {
          return ch >= "a" && ch <= "z" || ch >= "A" && ch <= "Z" || ch === "_";
        }
        function isNum(ch) {
          return ch >= "0" && ch <= "9" || ch === "-";
        }
        function isAlphaNum(ch) {
          return ch >= "a" && ch <= "z" || ch >= "A" && ch <= "Z" || ch >= "0" && ch <= "9" || ch === "_";
        }
        function Lexer() {
        }
        Lexer.prototype = {
          tokenize: function(stream) {
            var tokens = [];
            this._current = 0;
            var start;
            var identifier;
            var token;
            while (this._current < stream.length) {
              if (isAlpha(stream[this._current])) {
                start = this._current;
                identifier = this._consumeUnquotedIdentifier(stream);
                tokens.push({
                  type: TOK_UNQUOTEDIDENTIFIER,
                  value: identifier,
                  start
                });
              } else if (basicTokens[stream[this._current]] !== void 0) {
                tokens.push({
                  type: basicTokens[stream[this._current]],
                  value: stream[this._current],
                  start: this._current
                });
                this._current++;
              } else if (isNum(stream[this._current])) {
                token = this._consumeNumber(stream);
                tokens.push(token);
              } else if (stream[this._current] === "[") {
                token = this._consumeLBracket(stream);
                tokens.push(token);
              } else if (stream[this._current] === '"') {
                start = this._current;
                identifier = this._consumeQuotedIdentifier(stream);
                tokens.push({
                  type: TOK_QUOTEDIDENTIFIER,
                  value: identifier,
                  start
                });
              } else if (stream[this._current] === "'") {
                start = this._current;
                identifier = this._consumeRawStringLiteral(stream);
                tokens.push({
                  type: TOK_LITERAL,
                  value: identifier,
                  start
                });
              } else if (stream[this._current] === "`") {
                start = this._current;
                var literal = this._consumeLiteral(stream);
                tokens.push({
                  type: TOK_LITERAL,
                  value: literal,
                  start
                });
              } else if (operatorStartToken[stream[this._current]] !== void 0) {
                tokens.push(this._consumeOperator(stream));
              } else if (skipChars[stream[this._current]] !== void 0) {
                this._current++;
              } else if (stream[this._current] === "&") {
                start = this._current;
                this._current++;
                if (stream[this._current] === "&") {
                  this._current++;
                  tokens.push({ type: TOK_AND, value: "&&", start });
                } else {
                  tokens.push({ type: TOK_EXPREF, value: "&", start });
                }
              } else if (stream[this._current] === "|") {
                start = this._current;
                this._current++;
                if (stream[this._current] === "|") {
                  this._current++;
                  tokens.push({ type: TOK_OR, value: "||", start });
                } else {
                  tokens.push({ type: TOK_PIPE, value: "|", start });
                }
              } else {
                var error = new Error("Unknown character:" + stream[this._current]);
                error.name = "LexerError";
                throw error;
              }
            }
            return tokens;
          },
          _consumeUnquotedIdentifier: function(stream) {
            var start = this._current;
            this._current++;
            while (this._current < stream.length && isAlphaNum(stream[this._current])) {
              this._current++;
            }
            return stream.slice(start, this._current);
          },
          _consumeQuotedIdentifier: function(stream) {
            var start = this._current;
            this._current++;
            var maxLength = stream.length;
            while (stream[this._current] !== '"' && this._current < maxLength) {
              var current = this._current;
              if (stream[current] === "\\" && (stream[current + 1] === "\\" || stream[current + 1] === '"')) {
                current += 2;
              } else {
                current++;
              }
              this._current = current;
            }
            this._current++;
            return JSON.parse(stream.slice(start, this._current));
          },
          _consumeRawStringLiteral: function(stream) {
            var start = this._current;
            this._current++;
            var maxLength = stream.length;
            while (stream[this._current] !== "'" && this._current < maxLength) {
              var current = this._current;
              if (stream[current] === "\\" && (stream[current + 1] === "\\" || stream[current + 1] === "'")) {
                current += 2;
              } else {
                current++;
              }
              this._current = current;
            }
            this._current++;
            var literal = stream.slice(start + 1, this._current - 1);
            return literal.replace("\\'", "'");
          },
          _consumeNumber: function(stream) {
            var start = this._current;
            this._current++;
            var maxLength = stream.length;
            while (isNum(stream[this._current]) && this._current < maxLength) {
              this._current++;
            }
            var value = parseInt(stream.slice(start, this._current));
            return { type: TOK_NUMBER, value, start };
          },
          _consumeLBracket: function(stream) {
            var start = this._current;
            this._current++;
            if (stream[this._current] === "?") {
              this._current++;
              return { type: TOK_FILTER, value: "[?", start };
            } else if (stream[this._current] === "]") {
              this._current++;
              return { type: TOK_FLATTEN, value: "[]", start };
            } else {
              return { type: TOK_LBRACKET, value: "[", start };
            }
          },
          _consumeOperator: function(stream) {
            var start = this._current;
            var startingChar = stream[start];
            this._current++;
            if (startingChar === "!") {
              if (stream[this._current] === "=") {
                this._current++;
                return { type: TOK_NE, value: "!=", start };
              } else {
                return { type: TOK_NOT, value: "!", start };
              }
            } else if (startingChar === "<") {
              if (stream[this._current] === "=") {
                this._current++;
                return { type: TOK_LTE, value: "<=", start };
              } else {
                return { type: TOK_LT, value: "<", start };
              }
            } else if (startingChar === ">") {
              if (stream[this._current] === "=") {
                this._current++;
                return { type: TOK_GTE, value: ">=", start };
              } else {
                return { type: TOK_GT, value: ">", start };
              }
            } else if (startingChar === "=") {
              if (stream[this._current] === "=") {
                this._current++;
                return { type: TOK_EQ, value: "==", start };
              }
            }
          },
          _consumeLiteral: function(stream) {
            this._current++;
            var start = this._current;
            var maxLength = stream.length;
            var literal;
            while (stream[this._current] !== "`" && this._current < maxLength) {
              var current = this._current;
              if (stream[current] === "\\" && (stream[current + 1] === "\\" || stream[current + 1] === "`")) {
                current += 2;
              } else {
                current++;
              }
              this._current = current;
            }
            var literalString = trimLeft(stream.slice(start, this._current));
            literalString = literalString.replace("\\`", "`");
            if (this._looksLikeJSON(literalString)) {
              literal = JSON.parse(literalString);
            } else {
              literal = JSON.parse('"' + literalString + '"');
            }
            this._current++;
            return literal;
          },
          _looksLikeJSON: function(literalString) {
            var startingChars = '[{"';
            var jsonLiterals = ["true", "false", "null"];
            var numberLooking = "-0123456789";
            if (literalString === "") {
              return false;
            } else if (startingChars.indexOf(literalString[0]) >= 0) {
              return true;
            } else if (jsonLiterals.indexOf(literalString) >= 0) {
              return true;
            } else if (numberLooking.indexOf(literalString[0]) >= 0) {
              try {
                JSON.parse(literalString);
                return true;
              } catch (ex) {
                return false;
              }
            } else {
              return false;
            }
          }
        };
        var bindingPower = {};
        bindingPower[TOK_EOF] = 0;
        bindingPower[TOK_UNQUOTEDIDENTIFIER] = 0;
        bindingPower[TOK_QUOTEDIDENTIFIER] = 0;
        bindingPower[TOK_RBRACKET] = 0;
        bindingPower[TOK_RPAREN] = 0;
        bindingPower[TOK_COMMA] = 0;
        bindingPower[TOK_RBRACE] = 0;
        bindingPower[TOK_NUMBER] = 0;
        bindingPower[TOK_CURRENT] = 0;
        bindingPower[TOK_EXPREF] = 0;
        bindingPower[TOK_PIPE] = 1;
        bindingPower[TOK_OR] = 2;
        bindingPower[TOK_AND] = 3;
        bindingPower[TOK_EQ] = 5;
        bindingPower[TOK_GT] = 5;
        bindingPower[TOK_LT] = 5;
        bindingPower[TOK_GTE] = 5;
        bindingPower[TOK_LTE] = 5;
        bindingPower[TOK_NE] = 5;
        bindingPower[TOK_FLATTEN] = 9;
        bindingPower[TOK_STAR] = 20;
        bindingPower[TOK_FILTER] = 21;
        bindingPower[TOK_DOT] = 40;
        bindingPower[TOK_NOT] = 45;
        bindingPower[TOK_LBRACE] = 50;
        bindingPower[TOK_LBRACKET] = 55;
        bindingPower[TOK_LPAREN] = 60;
        function Parser() {
        }
        Parser.prototype = {
          parse: function(expression) {
            this._loadTokens(expression);
            this.index = 0;
            var ast = this.expression(0);
            if (this._lookahead(0) !== TOK_EOF) {
              var t = this._lookaheadToken(0);
              var error = new Error(
                "Unexpected token type: " + t.type + ", value: " + t.value
              );
              error.name = "ParserError";
              throw error;
            }
            return ast;
          },
          _loadTokens: function(expression) {
            var lexer = new Lexer();
            var tokens = lexer.tokenize(expression);
            tokens.push({ type: TOK_EOF, value: "", start: expression.length });
            this.tokens = tokens;
          },
          expression: function(rbp) {
            var leftToken = this._lookaheadToken(0);
            this._advance();
            var left = this.nud(leftToken);
            var currentToken = this._lookahead(0);
            while (rbp < bindingPower[currentToken]) {
              this._advance();
              left = this.led(currentToken, left);
              currentToken = this._lookahead(0);
            }
            return left;
          },
          _lookahead: function(number) {
            return this.tokens[this.index + number].type;
          },
          _lookaheadToken: function(number) {
            return this.tokens[this.index + number];
          },
          _advance: function() {
            this.index++;
          },
          nud: function(token) {
            var left;
            var right;
            var expression;
            switch (token.type) {
              case TOK_LITERAL:
                return { type: "Literal", value: token.value };
              case TOK_UNQUOTEDIDENTIFIER:
                return { type: "Field", name: token.value };
              case TOK_QUOTEDIDENTIFIER:
                var node = { type: "Field", name: token.value };
                if (this._lookahead(0) === TOK_LPAREN) {
                  throw new Error("Quoted identifier not allowed for function names.");
                }
                return node;
              case TOK_NOT:
                right = this.expression(bindingPower.Not);
                return { type: "NotExpression", children: [right] };
              case TOK_STAR:
                left = { type: "Identity" };
                right = null;
                if (this._lookahead(0) === TOK_RBRACKET) {
                  right = { type: "Identity" };
                } else {
                  right = this._parseProjectionRHS(bindingPower.Star);
                }
                return { type: "ValueProjection", children: [left, right] };
              case TOK_FILTER:
                return this.led(token.type, { type: "Identity" });
              case TOK_LBRACE:
                return this._parseMultiselectHash();
              case TOK_FLATTEN:
                left = { type: TOK_FLATTEN, children: [{ type: "Identity" }] };
                right = this._parseProjectionRHS(bindingPower.Flatten);
                return { type: "Projection", children: [left, right] };
              case TOK_LBRACKET:
                if (this._lookahead(0) === TOK_NUMBER || this._lookahead(0) === TOK_COLON) {
                  right = this._parseIndexExpression();
                  return this._projectIfSlice({ type: "Identity" }, right);
                } else if (this._lookahead(0) === TOK_STAR && this._lookahead(1) === TOK_RBRACKET) {
                  this._advance();
                  this._advance();
                  right = this._parseProjectionRHS(bindingPower.Star);
                  return {
                    type: "Projection",
                    children: [{ type: "Identity" }, right]
                  };
                }
                return this._parseMultiselectList();
              case TOK_CURRENT:
                return { type: TOK_CURRENT };
              case TOK_EXPREF:
                expression = this.expression(bindingPower.Expref);
                return { type: "ExpressionReference", children: [expression] };
              case TOK_LPAREN:
                var args = [];
                while (this._lookahead(0) !== TOK_RPAREN) {
                  if (this._lookahead(0) === TOK_CURRENT) {
                    expression = { type: TOK_CURRENT };
                    this._advance();
                  } else {
                    expression = this.expression(0);
                  }
                  args.push(expression);
                }
                this._match(TOK_RPAREN);
                return args[0];
              default:
                this._errorToken(token);
            }
          },
          led: function(tokenName, left) {
            var right;
            switch (tokenName) {
              case TOK_DOT:
                var rbp = bindingPower.Dot;
                if (this._lookahead(0) !== TOK_STAR) {
                  right = this._parseDotRHS(rbp);
                  return { type: "Subexpression", children: [left, right] };
                }
                this._advance();
                right = this._parseProjectionRHS(rbp);
                return { type: "ValueProjection", children: [left, right] };
              case TOK_PIPE:
                right = this.expression(bindingPower.Pipe);
                return { type: TOK_PIPE, children: [left, right] };
              case TOK_OR:
                right = this.expression(bindingPower.Or);
                return { type: "OrExpression", children: [left, right] };
              case TOK_AND:
                right = this.expression(bindingPower.And);
                return { type: "AndExpression", children: [left, right] };
              case TOK_LPAREN:
                var name = left.name;
                var args = [];
                var expression, node;
                while (this._lookahead(0) !== TOK_RPAREN) {
                  if (this._lookahead(0) === TOK_CURRENT) {
                    expression = { type: TOK_CURRENT };
                    this._advance();
                  } else {
                    expression = this.expression(0);
                  }
                  if (this._lookahead(0) === TOK_COMMA) {
                    this._match(TOK_COMMA);
                  }
                  args.push(expression);
                }
                this._match(TOK_RPAREN);
                node = { type: "Function", name, children: args };
                return node;
              case TOK_FILTER:
                var condition = this.expression(0);
                this._match(TOK_RBRACKET);
                if (this._lookahead(0) === TOK_FLATTEN) {
                  right = { type: "Identity" };
                } else {
                  right = this._parseProjectionRHS(bindingPower.Filter);
                }
                return { type: "FilterProjection", children: [left, right, condition] };
              case TOK_FLATTEN:
                var leftNode = { type: TOK_FLATTEN, children: [left] };
                var rightNode = this._parseProjectionRHS(bindingPower.Flatten);
                return { type: "Projection", children: [leftNode, rightNode] };
              case TOK_EQ:
              case TOK_NE:
              case TOK_GT:
              case TOK_GTE:
              case TOK_LT:
              case TOK_LTE:
                return this._parseComparator(left, tokenName);
              case TOK_LBRACKET:
                var token = this._lookaheadToken(0);
                if (token.type === TOK_NUMBER || token.type === TOK_COLON) {
                  right = this._parseIndexExpression();
                  return this._projectIfSlice(left, right);
                }
                this._match(TOK_STAR);
                this._match(TOK_RBRACKET);
                right = this._parseProjectionRHS(bindingPower.Star);
                return { type: "Projection", children: [left, right] };
              default:
                this._errorToken(this._lookaheadToken(0));
            }
          },
          _match: function(tokenType) {
            if (this._lookahead(0) === tokenType) {
              this._advance();
            } else {
              var t = this._lookaheadToken(0);
              var error = new Error("Expected " + tokenType + ", got: " + t.type);
              error.name = "ParserError";
              throw error;
            }
          },
          _errorToken: function(token) {
            var error = new Error("Invalid token (" + token.type + '): "' + token.value + '"');
            error.name = "ParserError";
            throw error;
          },
          _parseIndexExpression: function() {
            if (this._lookahead(0) === TOK_COLON || this._lookahead(1) === TOK_COLON) {
              return this._parseSliceExpression();
            } else {
              var node = {
                type: "Index",
                value: this._lookaheadToken(0).value
              };
              this._advance();
              this._match(TOK_RBRACKET);
              return node;
            }
          },
          _projectIfSlice: function(left, right) {
            var indexExpr = { type: "IndexExpression", children: [left, right] };
            if (right.type === "Slice") {
              return {
                type: "Projection",
                children: [indexExpr, this._parseProjectionRHS(bindingPower.Star)]
              };
            } else {
              return indexExpr;
            }
          },
          _parseSliceExpression: function() {
            var parts = [null, null, null];
            var index = 0;
            var currentToken = this._lookahead(0);
            while (currentToken !== TOK_RBRACKET && index < 3) {
              if (currentToken === TOK_COLON) {
                index++;
                this._advance();
              } else if (currentToken === TOK_NUMBER) {
                parts[index] = this._lookaheadToken(0).value;
                this._advance();
              } else {
                var t = this._lookahead(0);
                var error = new Error("Syntax error, unexpected token: " + t.value + "(" + t.type + ")");
                error.name = "Parsererror";
                throw error;
              }
              currentToken = this._lookahead(0);
            }
            this._match(TOK_RBRACKET);
            return {
              type: "Slice",
              children: parts
            };
          },
          _parseComparator: function(left, comparator) {
            var right = this.expression(bindingPower[comparator]);
            return { type: "Comparator", name: comparator, children: [left, right] };
          },
          _parseDotRHS: function(rbp) {
            var lookahead = this._lookahead(0);
            var exprTokens = [TOK_UNQUOTEDIDENTIFIER, TOK_QUOTEDIDENTIFIER, TOK_STAR];
            if (exprTokens.indexOf(lookahead) >= 0) {
              return this.expression(rbp);
            } else if (lookahead === TOK_LBRACKET) {
              this._match(TOK_LBRACKET);
              return this._parseMultiselectList();
            } else if (lookahead === TOK_LBRACE) {
              this._match(TOK_LBRACE);
              return this._parseMultiselectHash();
            }
          },
          _parseProjectionRHS: function(rbp) {
            var right;
            if (bindingPower[this._lookahead(0)] < 10) {
              right = { type: "Identity" };
            } else if (this._lookahead(0) === TOK_LBRACKET) {
              right = this.expression(rbp);
            } else if (this._lookahead(0) === TOK_FILTER) {
              right = this.expression(rbp);
            } else if (this._lookahead(0) === TOK_DOT) {
              this._match(TOK_DOT);
              right = this._parseDotRHS(rbp);
            } else {
              var t = this._lookaheadToken(0);
              var error = new Error("Sytanx error, unexpected token: " + t.value + "(" + t.type + ")");
              error.name = "ParserError";
              throw error;
            }
            return right;
          },
          _parseMultiselectList: function() {
            var expressions = [];
            while (this._lookahead(0) !== TOK_RBRACKET) {
              var expression = this.expression(0);
              expressions.push(expression);
              if (this._lookahead(0) === TOK_COMMA) {
                this._match(TOK_COMMA);
                if (this._lookahead(0) === TOK_RBRACKET) {
                  throw new Error("Unexpected token Rbracket");
                }
              }
            }
            this._match(TOK_RBRACKET);
            return { type: "MultiSelectList", children: expressions };
          },
          _parseMultiselectHash: function() {
            var pairs = [];
            var identifierTypes = [TOK_UNQUOTEDIDENTIFIER, TOK_QUOTEDIDENTIFIER];
            var keyToken, keyName, value, node;
            for (; ; ) {
              keyToken = this._lookaheadToken(0);
              if (identifierTypes.indexOf(keyToken.type) < 0) {
                throw new Error("Expecting an identifier token, got: " + keyToken.type);
              }
              keyName = keyToken.value;
              this._advance();
              this._match(TOK_COLON);
              value = this.expression(0);
              node = { type: "KeyValuePair", name: keyName, value };
              pairs.push(node);
              if (this._lookahead(0) === TOK_COMMA) {
                this._match(TOK_COMMA);
              } else if (this._lookahead(0) === TOK_RBRACE) {
                this._match(TOK_RBRACE);
                break;
              }
            }
            return { type: "MultiSelectHash", children: pairs };
          }
        };
        function TreeInterpreter(runtime) {
          this.runtime = runtime;
        }
        TreeInterpreter.prototype = {
          search: function(node, value) {
            return this.visit(node, value);
          },
          visit: function(node, value) {
            var matched, current, result, first, second, field, left, right, collected, i;
            switch (node.type) {
              case "Field":
                if (value !== null && isObject(value)) {
                  field = value[node.name];
                  if (field === void 0) {
                    return null;
                  } else {
                    return field;
                  }
                }
                return null;
              case "Subexpression":
                result = this.visit(node.children[0], value);
                for (i = 1; i < node.children.length; i++) {
                  result = this.visit(node.children[1], result);
                  if (result === null) {
                    return null;
                  }
                }
                return result;
              case "IndexExpression":
                left = this.visit(node.children[0], value);
                right = this.visit(node.children[1], left);
                return right;
              case "Index":
                if (!isArray(value)) {
                  return null;
                }
                var index = node.value;
                if (index < 0) {
                  index = value.length + index;
                }
                result = value[index];
                if (result === void 0) {
                  result = null;
                }
                return result;
              case "Slice":
                if (!isArray(value)) {
                  return null;
                }
                var sliceParams = node.children.slice(0);
                var computed = this.computeSliceParams(value.length, sliceParams);
                var start = computed[0];
                var stop = computed[1];
                var step = computed[2];
                result = [];
                if (step > 0) {
                  for (i = start; i < stop; i += step) {
                    result.push(value[i]);
                  }
                } else {
                  for (i = start; i > stop; i += step) {
                    result.push(value[i]);
                  }
                }
                return result;
              case "Projection":
                var base = this.visit(node.children[0], value);
                if (!isArray(base)) {
                  return null;
                }
                collected = [];
                for (i = 0; i < base.length; i++) {
                  current = this.visit(node.children[1], base[i]);
                  if (current !== null) {
                    collected.push(current);
                  }
                }
                return collected;
              case "ValueProjection":
                base = this.visit(node.children[0], value);
                if (!isObject(base)) {
                  return null;
                }
                collected = [];
                var values = objValues(base);
                for (i = 0; i < values.length; i++) {
                  current = this.visit(node.children[1], values[i]);
                  if (current !== null) {
                    collected.push(current);
                  }
                }
                return collected;
              case "FilterProjection":
                base = this.visit(node.children[0], value);
                if (!isArray(base)) {
                  return null;
                }
                var filtered = [];
                var finalResults = [];
                for (i = 0; i < base.length; i++) {
                  matched = this.visit(node.children[2], base[i]);
                  if (!isFalse(matched)) {
                    filtered.push(base[i]);
                  }
                }
                for (var j = 0; j < filtered.length; j++) {
                  current = this.visit(node.children[1], filtered[j]);
                  if (current !== null) {
                    finalResults.push(current);
                  }
                }
                return finalResults;
              case "Comparator":
                first = this.visit(node.children[0], value);
                second = this.visit(node.children[1], value);
                switch (node.name) {
                  case TOK_EQ:
                    result = strictDeepEqual(first, second);
                    break;
                  case TOK_NE:
                    result = !strictDeepEqual(first, second);
                    break;
                  case TOK_GT:
                    result = first > second;
                    break;
                  case TOK_GTE:
                    result = first >= second;
                    break;
                  case TOK_LT:
                    result = first < second;
                    break;
                  case TOK_LTE:
                    result = first <= second;
                    break;
                  default:
                    throw new Error("Unknown comparator: " + node.name);
                }
                return result;
              case TOK_FLATTEN:
                var original = this.visit(node.children[0], value);
                if (!isArray(original)) {
                  return null;
                }
                var merged = [];
                for (i = 0; i < original.length; i++) {
                  current = original[i];
                  if (isArray(current)) {
                    merged.push.apply(merged, current);
                  } else {
                    merged.push(current);
                  }
                }
                return merged;
              case "Identity":
                return value;
              case "MultiSelectList":
                if (value === null) {
                  return null;
                }
                collected = [];
                for (i = 0; i < node.children.length; i++) {
                  collected.push(this.visit(node.children[i], value));
                }
                return collected;
              case "MultiSelectHash":
                if (value === null) {
                  return null;
                }
                collected = {};
                var child;
                for (i = 0; i < node.children.length; i++) {
                  child = node.children[i];
                  collected[child.name] = this.visit(child.value, value);
                }
                return collected;
              case "OrExpression":
                matched = this.visit(node.children[0], value);
                if (isFalse(matched)) {
                  matched = this.visit(node.children[1], value);
                }
                return matched;
              case "AndExpression":
                first = this.visit(node.children[0], value);
                if (isFalse(first) === true) {
                  return first;
                }
                return this.visit(node.children[1], value);
              case "NotExpression":
                first = this.visit(node.children[0], value);
                return isFalse(first);
              case "Literal":
                return node.value;
              case TOK_PIPE:
                left = this.visit(node.children[0], value);
                return this.visit(node.children[1], left);
              case TOK_CURRENT:
                return value;
              case "Function":
                var resolvedArgs = [];
                for (i = 0; i < node.children.length; i++) {
                  resolvedArgs.push(this.visit(node.children[i], value));
                }
                return this.runtime.callFunction(node.name, resolvedArgs);
              case "ExpressionReference":
                var refNode = node.children[0];
                refNode.jmespathType = TOK_EXPREF;
                return refNode;
              default:
                throw new Error("Unknown node type: " + node.type);
            }
          },
          computeSliceParams: function(arrayLength, sliceParams) {
            var start = sliceParams[0];
            var stop = sliceParams[1];
            var step = sliceParams[2];
            var computed = [null, null, null];
            if (step === null) {
              step = 1;
            } else if (step === 0) {
              var error = new Error("Invalid slice, step cannot be 0");
              error.name = "RuntimeError";
              throw error;
            }
            var stepValueNegative = step < 0 ? true : false;
            if (start === null) {
              start = stepValueNegative ? arrayLength - 1 : 0;
            } else {
              start = this.capSliceRange(arrayLength, start, step);
            }
            if (stop === null) {
              stop = stepValueNegative ? -1 : arrayLength;
            } else {
              stop = this.capSliceRange(arrayLength, stop, step);
            }
            computed[0] = start;
            computed[1] = stop;
            computed[2] = step;
            return computed;
          },
          capSliceRange: function(arrayLength, actualValue, step) {
            if (actualValue < 0) {
              actualValue += arrayLength;
              if (actualValue < 0) {
                actualValue = step < 0 ? -1 : 0;
              }
            } else if (actualValue >= arrayLength) {
              actualValue = step < 0 ? arrayLength - 1 : arrayLength;
            }
            return actualValue;
          }
        };
        function Runtime(interpreter) {
          this._interpreter = interpreter;
          this.functionTable = {
            // name: [function, <signature>]
            // The <signature> can be:
            //
            // {
            //   args: [[type1, type2], [type1, type2]],
            //   variadic: true|false
            // }
            //
            // Each arg in the arg list is a list of valid types
            // (if the function is overloaded and supports multiple
            // types.  If the type is "any" then no type checking
            // occurs on the argument.  Variadic is optional
            // and if not provided is assumed to be false.
            abs: { _func: this._functionAbs, _signature: [{ types: [TYPE_NUMBER] }] },
            avg: { _func: this._functionAvg, _signature: [{ types: [TYPE_ARRAY_NUMBER] }] },
            ceil: { _func: this._functionCeil, _signature: [{ types: [TYPE_NUMBER] }] },
            contains: {
              _func: this._functionContains,
              _signature: [
                { types: [TYPE_STRING, TYPE_ARRAY] },
                { types: [TYPE_ANY] }
              ]
            },
            "ends_with": {
              _func: this._functionEndsWith,
              _signature: [{ types: [TYPE_STRING] }, { types: [TYPE_STRING] }]
            },
            floor: { _func: this._functionFloor, _signature: [{ types: [TYPE_NUMBER] }] },
            length: {
              _func: this._functionLength,
              _signature: [{ types: [TYPE_STRING, TYPE_ARRAY, TYPE_OBJECT] }]
            },
            map: {
              _func: this._functionMap,
              _signature: [{ types: [TYPE_EXPREF] }, { types: [TYPE_ARRAY] }]
            },
            max: {
              _func: this._functionMax,
              _signature: [{ types: [TYPE_ARRAY_NUMBER, TYPE_ARRAY_STRING] }]
            },
            "merge": {
              _func: this._functionMerge,
              _signature: [{ types: [TYPE_OBJECT], variadic: true }]
            },
            "max_by": {
              _func: this._functionMaxBy,
              _signature: [{ types: [TYPE_ARRAY] }, { types: [TYPE_EXPREF] }]
            },
            sum: { _func: this._functionSum, _signature: [{ types: [TYPE_ARRAY_NUMBER] }] },
            "starts_with": {
              _func: this._functionStartsWith,
              _signature: [{ types: [TYPE_STRING] }, { types: [TYPE_STRING] }]
            },
            min: {
              _func: this._functionMin,
              _signature: [{ types: [TYPE_ARRAY_NUMBER, TYPE_ARRAY_STRING] }]
            },
            "min_by": {
              _func: this._functionMinBy,
              _signature: [{ types: [TYPE_ARRAY] }, { types: [TYPE_EXPREF] }]
            },
            type: { _func: this._functionType, _signature: [{ types: [TYPE_ANY] }] },
            keys: { _func: this._functionKeys, _signature: [{ types: [TYPE_OBJECT] }] },
            values: { _func: this._functionValues, _signature: [{ types: [TYPE_OBJECT] }] },
            sort: { _func: this._functionSort, _signature: [{ types: [TYPE_ARRAY_STRING, TYPE_ARRAY_NUMBER] }] },
            "sort_by": {
              _func: this._functionSortBy,
              _signature: [{ types: [TYPE_ARRAY] }, { types: [TYPE_EXPREF] }]
            },
            join: {
              _func: this._functionJoin,
              _signature: [
                { types: [TYPE_STRING] },
                { types: [TYPE_ARRAY_STRING] }
              ]
            },
            reverse: {
              _func: this._functionReverse,
              _signature: [{ types: [TYPE_STRING, TYPE_ARRAY] }]
            },
            "to_array": { _func: this._functionToArray, _signature: [{ types: [TYPE_ANY] }] },
            "to_string": { _func: this._functionToString, _signature: [{ types: [TYPE_ANY] }] },
            "to_number": { _func: this._functionToNumber, _signature: [{ types: [TYPE_ANY] }] },
            "not_null": {
              _func: this._functionNotNull,
              _signature: [{ types: [TYPE_ANY], variadic: true }]
            }
          };
        }
        Runtime.prototype = {
          callFunction: function(name, resolvedArgs) {
            var functionEntry = this.functionTable[name];
            if (functionEntry === void 0) {
              throw new Error("Unknown function: " + name + "()");
            }
            this._validateArgs(name, resolvedArgs, functionEntry._signature);
            return functionEntry._func.call(this, resolvedArgs);
          },
          _validateArgs: function(name, args, signature) {
            var pluralized;
            if (signature[signature.length - 1].variadic) {
              if (args.length < signature.length) {
                pluralized = signature.length === 1 ? " argument" : " arguments";
                throw new Error("ArgumentError: " + name + "() takes at least" + signature.length + pluralized + " but received " + args.length);
              }
            } else if (args.length !== signature.length) {
              pluralized = signature.length === 1 ? " argument" : " arguments";
              throw new Error("ArgumentError: " + name + "() takes " + signature.length + pluralized + " but received " + args.length);
            }
            var currentSpec;
            var actualType;
            var typeMatched;
            for (var i = 0; i < signature.length; i++) {
              typeMatched = false;
              currentSpec = signature[i].types;
              actualType = this._getTypeName(args[i]);
              for (var j = 0; j < currentSpec.length; j++) {
                if (this._typeMatches(actualType, currentSpec[j], args[i])) {
                  typeMatched = true;
                  break;
                }
              }
              if (!typeMatched) {
                var expected = currentSpec.map(function(typeIdentifier) {
                  return TYPE_NAME_TABLE[typeIdentifier];
                }).join(",");
                throw new Error("TypeError: " + name + "() expected argument " + (i + 1) + " to be type " + expected + " but received type " + TYPE_NAME_TABLE[actualType] + " instead.");
              }
            }
          },
          _typeMatches: function(actual, expected, argValue) {
            if (expected === TYPE_ANY) {
              return true;
            }
            if (expected === TYPE_ARRAY_STRING || expected === TYPE_ARRAY_NUMBER || expected === TYPE_ARRAY) {
              if (expected === TYPE_ARRAY) {
                return actual === TYPE_ARRAY;
              } else if (actual === TYPE_ARRAY) {
                var subtype;
                if (expected === TYPE_ARRAY_NUMBER) {
                  subtype = TYPE_NUMBER;
                } else if (expected === TYPE_ARRAY_STRING) {
                  subtype = TYPE_STRING;
                }
                for (var i = 0; i < argValue.length; i++) {
                  if (!this._typeMatches(
                    this._getTypeName(argValue[i]),
                    subtype,
                    argValue[i]
                  )) {
                    return false;
                  }
                }
                return true;
              }
            } else {
              return actual === expected;
            }
          },
          _getTypeName: function(obj) {
            switch (Object.prototype.toString.call(obj)) {
              case "[object String]":
                return TYPE_STRING;
              case "[object Number]":
                return TYPE_NUMBER;
              case "[object Array]":
                return TYPE_ARRAY;
              case "[object Boolean]":
                return TYPE_BOOLEAN;
              case "[object Null]":
                return TYPE_NULL;
              case "[object Object]":
                if (obj.jmespathType === TOK_EXPREF) {
                  return TYPE_EXPREF;
                } else {
                  return TYPE_OBJECT;
                }
            }
          },
          _functionStartsWith: function(resolvedArgs) {
            return resolvedArgs[0].lastIndexOf(resolvedArgs[1]) === 0;
          },
          _functionEndsWith: function(resolvedArgs) {
            var searchStr = resolvedArgs[0];
            var suffix = resolvedArgs[1];
            return searchStr.indexOf(suffix, searchStr.length - suffix.length) !== -1;
          },
          _functionReverse: function(resolvedArgs) {
            var typeName = this._getTypeName(resolvedArgs[0]);
            if (typeName === TYPE_STRING) {
              var originalStr = resolvedArgs[0];
              var reversedStr = "";
              for (var i = originalStr.length - 1; i >= 0; i--) {
                reversedStr += originalStr[i];
              }
              return reversedStr;
            } else {
              var reversedArray = resolvedArgs[0].slice(0);
              reversedArray.reverse();
              return reversedArray;
            }
          },
          _functionAbs: function(resolvedArgs) {
            return Math.abs(resolvedArgs[0]);
          },
          _functionCeil: function(resolvedArgs) {
            return Math.ceil(resolvedArgs[0]);
          },
          _functionAvg: function(resolvedArgs) {
            var sum = 0;
            var inputArray = resolvedArgs[0];
            for (var i = 0; i < inputArray.length; i++) {
              sum += inputArray[i];
            }
            return sum / inputArray.length;
          },
          _functionContains: function(resolvedArgs) {
            return resolvedArgs[0].indexOf(resolvedArgs[1]) >= 0;
          },
          _functionFloor: function(resolvedArgs) {
            return Math.floor(resolvedArgs[0]);
          },
          _functionLength: function(resolvedArgs) {
            if (!isObject(resolvedArgs[0])) {
              return resolvedArgs[0].length;
            } else {
              return Object.keys(resolvedArgs[0]).length;
            }
          },
          _functionMap: function(resolvedArgs) {
            var mapped = [];
            var interpreter = this._interpreter;
            var exprefNode = resolvedArgs[0];
            var elements = resolvedArgs[1];
            for (var i = 0; i < elements.length; i++) {
              mapped.push(interpreter.visit(exprefNode, elements[i]));
            }
            return mapped;
          },
          _functionMerge: function(resolvedArgs) {
            var merged = {};
            for (var i = 0; i < resolvedArgs.length; i++) {
              var current = resolvedArgs[i];
              for (var key in current) {
                merged[key] = current[key];
              }
            }
            return merged;
          },
          _functionMax: function(resolvedArgs) {
            if (resolvedArgs[0].length > 0) {
              var typeName = this._getTypeName(resolvedArgs[0][0]);
              if (typeName === TYPE_NUMBER) {
                return Math.max.apply(Math, resolvedArgs[0]);
              } else {
                var elements = resolvedArgs[0];
                var maxElement = elements[0];
                for (var i = 1; i < elements.length; i++) {
                  if (maxElement.localeCompare(elements[i]) < 0) {
                    maxElement = elements[i];
                  }
                }
                return maxElement;
              }
            } else {
              return null;
            }
          },
          _functionMin: function(resolvedArgs) {
            if (resolvedArgs[0].length > 0) {
              var typeName = this._getTypeName(resolvedArgs[0][0]);
              if (typeName === TYPE_NUMBER) {
                return Math.min.apply(Math, resolvedArgs[0]);
              } else {
                var elements = resolvedArgs[0];
                var minElement = elements[0];
                for (var i = 1; i < elements.length; i++) {
                  if (elements[i].localeCompare(minElement) < 0) {
                    minElement = elements[i];
                  }
                }
                return minElement;
              }
            } else {
              return null;
            }
          },
          _functionSum: function(resolvedArgs) {
            var sum = 0;
            var listToSum = resolvedArgs[0];
            for (var i = 0; i < listToSum.length; i++) {
              sum += listToSum[i];
            }
            return sum;
          },
          _functionType: function(resolvedArgs) {
            switch (this._getTypeName(resolvedArgs[0])) {
              case TYPE_NUMBER:
                return "number";
              case TYPE_STRING:
                return "string";
              case TYPE_ARRAY:
                return "array";
              case TYPE_OBJECT:
                return "object";
              case TYPE_BOOLEAN:
                return "boolean";
              case TYPE_EXPREF:
                return "expref";
              case TYPE_NULL:
                return "null";
            }
          },
          _functionKeys: function(resolvedArgs) {
            return Object.keys(resolvedArgs[0]);
          },
          _functionValues: function(resolvedArgs) {
            var obj = resolvedArgs[0];
            var keys = Object.keys(obj);
            var values = [];
            for (var i = 0; i < keys.length; i++) {
              values.push(obj[keys[i]]);
            }
            return values;
          },
          _functionJoin: function(resolvedArgs) {
            var joinChar = resolvedArgs[0];
            var listJoin = resolvedArgs[1];
            return listJoin.join(joinChar);
          },
          _functionToArray: function(resolvedArgs) {
            if (this._getTypeName(resolvedArgs[0]) === TYPE_ARRAY) {
              return resolvedArgs[0];
            } else {
              return [resolvedArgs[0]];
            }
          },
          _functionToString: function(resolvedArgs) {
            if (this._getTypeName(resolvedArgs[0]) === TYPE_STRING) {
              return resolvedArgs[0];
            } else {
              return JSON.stringify(resolvedArgs[0]);
            }
          },
          _functionToNumber: function(resolvedArgs) {
            var typeName = this._getTypeName(resolvedArgs[0]);
            var convertedValue;
            if (typeName === TYPE_NUMBER) {
              return resolvedArgs[0];
            } else if (typeName === TYPE_STRING) {
              convertedValue = +resolvedArgs[0];
              if (!isNaN(convertedValue)) {
                return convertedValue;
              }
            }
            return null;
          },
          _functionNotNull: function(resolvedArgs) {
            for (var i = 0; i < resolvedArgs.length; i++) {
              if (this._getTypeName(resolvedArgs[i]) !== TYPE_NULL) {
                return resolvedArgs[i];
              }
            }
            return null;
          },
          _functionSort: function(resolvedArgs) {
            var sortedArray = resolvedArgs[0].slice(0);
            sortedArray.sort();
            return sortedArray;
          },
          _functionSortBy: function(resolvedArgs) {
            var sortedArray = resolvedArgs[0].slice(0);
            if (sortedArray.length === 0) {
              return sortedArray;
            }
            var interpreter = this._interpreter;
            var exprefNode = resolvedArgs[1];
            var requiredType = this._getTypeName(
              interpreter.visit(exprefNode, sortedArray[0])
            );
            if ([TYPE_NUMBER, TYPE_STRING].indexOf(requiredType) < 0) {
              throw new Error("TypeError");
            }
            var that = this;
            var decorated = [];
            for (var i = 0; i < sortedArray.length; i++) {
              decorated.push([i, sortedArray[i]]);
            }
            decorated.sort(function(a, b) {
              var exprA = interpreter.visit(exprefNode, a[1]);
              var exprB = interpreter.visit(exprefNode, b[1]);
              if (that._getTypeName(exprA) !== requiredType) {
                throw new Error(
                  "TypeError: expected " + requiredType + ", received " + that._getTypeName(exprA)
                );
              } else if (that._getTypeName(exprB) !== requiredType) {
                throw new Error(
                  "TypeError: expected " + requiredType + ", received " + that._getTypeName(exprB)
                );
              }
              if (exprA > exprB) {
                return 1;
              } else if (exprA < exprB) {
                return -1;
              } else {
                return a[0] - b[0];
              }
            });
            for (var j = 0; j < decorated.length; j++) {
              sortedArray[j] = decorated[j][1];
            }
            return sortedArray;
          },
          _functionMaxBy: function(resolvedArgs) {
            var exprefNode = resolvedArgs[1];
            var resolvedArray = resolvedArgs[0];
            var keyFunction = this.createKeyFunction(exprefNode, [TYPE_NUMBER, TYPE_STRING]);
            var maxNumber = -Infinity;
            var maxRecord;
            var current;
            for (var i = 0; i < resolvedArray.length; i++) {
              current = keyFunction(resolvedArray[i]);
              if (current > maxNumber) {
                maxNumber = current;
                maxRecord = resolvedArray[i];
              }
            }
            return maxRecord;
          },
          _functionMinBy: function(resolvedArgs) {
            var exprefNode = resolvedArgs[1];
            var resolvedArray = resolvedArgs[0];
            var keyFunction = this.createKeyFunction(exprefNode, [TYPE_NUMBER, TYPE_STRING]);
            var minNumber = Infinity;
            var minRecord;
            var current;
            for (var i = 0; i < resolvedArray.length; i++) {
              current = keyFunction(resolvedArray[i]);
              if (current < minNumber) {
                minNumber = current;
                minRecord = resolvedArray[i];
              }
            }
            return minRecord;
          },
          createKeyFunction: function(exprefNode, allowedTypes) {
            var that = this;
            var interpreter = this._interpreter;
            var keyFunc = function(x) {
              var current = interpreter.visit(exprefNode, x);
              if (allowedTypes.indexOf(that._getTypeName(current)) < 0) {
                var msg = "TypeError: expected one of " + allowedTypes + ", received " + that._getTypeName(current);
                throw new Error(msg);
              }
              return current;
            };
            return keyFunc;
          }
        };
        function compile(stream) {
          var parser = new Parser();
          var ast = parser.parse(stream);
          return ast;
        }
        function tokenize(stream) {
          var lexer = new Lexer();
          return lexer.tokenize(stream);
        }
        function search(data, expression) {
          var parser = new Parser();
          var runtime = new Runtime();
          var interpreter = new TreeInterpreter(runtime);
          runtime._interpreter = interpreter;
          var node = parser.parse(expression);
          return interpreter.search(node, data);
        }
        exports2.tokenize = tokenize;
        exports2.compile = compile;
        exports2.search = search;
        exports2.strictDeepEqual = strictDeepEqual;
      })(typeof exports === "undefined" ? exports.jmespath = {} : exports);
    }
  });

  // flow-engine/src/index.ts
  var index_exports = {};
  __export(index_exports, {
    CONDITION_OPERATORS: () => CONDITION_OPERATORS,
    DEFAULT_LOOP_MAX_ITERATIONS: () => DEFAULT_LOOP_MAX_ITERATIONS,
    DEFAULT_MAX_NODE_CONCURRENCY: () => DEFAULT_MAX_NODE_CONCURRENCY,
    DEFAULT_SCRIPT_TIMEOUT_MS: () => DEFAULT_SCRIPT_TIMEOUT_MS,
    DEGRADED_SNAPSHOT_BYTES: () => DEGRADED_SNAPSHOT_BYTES,
    HEADERS_POLICY: () => HEADERS_POLICY,
    HttpFailureError: () => HttpFailureError,
    IllegalTransitionError: () => IllegalTransitionError,
    JSON_EXTRACT_POST_SCRIPT: () => JSON_EXTRACT_POST_SCRIPT,
    KEEP_REFERER: () => KEEP_REFERER,
    KEEP_UA: () => KEEP_UA,
    LOOP_HARD_MAX_ITERATIONS: () => LOOP_HARD_MAX_ITERATIONS,
    MIN_DEGRADED_SNAPSHOT_BYTES: () => MIN_DEGRADED_SNAPSHOT_BYTES,
    NODE_STATUS_TRANSITIONS: () => NODE_STATUS_TRANSITIONS,
    NodeStatusMachine: () => NodeStatusMachine,
    PRE_OVERRIDE_KEYS: () => PRE_OVERRIDE_KEYS,
    REF_ID_PATTERN: () => REF_ID_PATTERN,
    RUN_GRAPH_SNAPSHOT_MAX_BYTES: () => RUN_GRAPH_SNAPSHOT_MAX_BYTES,
    RUN_RECORD_MAX_BYTES: () => RUN_RECORD_MAX_BYTES,
    RUN_STATUS_TRANSITIONS: () => RUN_STATUS_TRANSITIONS,
    RunStatusMachine: () => RunStatusMachine,
    RunVariableOverlay: () => RunVariableOverlay,
    RunVariableStore: () => RunVariableStore,
    SANDBOX_CHECK_PARAM: () => SANDBOX_CHECK_PARAM,
    SANDBOX_DEADLINE_PARAM: () => SANDBOX_DEADLINE_PARAM,
    SCRIPT_ENV_PARAM_NAME: () => SCRIPT_ENV_PARAM_NAME,
    SCRIPT_PARAM_NAME: () => SCRIPT_PARAM_NAME,
    SNAPSHOT_MAX_BYTES: () => SNAPSHOT_MAX_BYTES,
    ScriptExecutionError: () => ScriptExecutionError,
    TRUNCATION_MARKER: () => TRUNCATION_MARKER,
    aggregateInputs: () => aggregateInputs,
    applySuggestions: () => applySuggestions,
    assertNodeTransition: () => assertNodeTransition,
    assertRunTransition: () => assertRunTransition,
    buildBodyWorkflow: () => buildBodyWorkflow,
    buildDownstreamSnapshot: () => buildDownstreamSnapshot,
    buildHeaderFidelityRule: () => buildHeaderFidelityRule,
    buildReplayRequest: () => buildReplayRequest,
    buildRunGraphSnapshot: () => buildRunGraphSnapshot,
    buildRunRecord: () => buildRunRecord,
    buildRunRecordShell: () => buildRunRecordShell,
    buildTemplateContext: () => buildTemplateContext,
    capSnapshot: () => capSnapshot,
    classifyNodeError: () => classifyNodeError,
    collectUpstreamCandidates: () => collectUpstreamCandidates,
    compileConditionTree: () => compileConditionTree,
    compileScript: () => compileScript,
    computeLoopBody: () => computeLoopBody,
    computeUpstreamClosure: () => computeUpstreamClosure,
    createAssertRunner: () => createAssertRunner,
    createConditionRunner: () => createConditionRunner,
    createDelayRunner: () => createDelayRunner,
    createEnvScriptParam: () => createEnvScriptParam,
    createHttpReplayRunner: () => createHttpReplayRunner,
    createLocalScriptPort: () => createLocalScriptPort,
    createLoopRunner: () => createLoopRunner,
    createRunId: () => createRunId,
    createSetVariableRunner: () => createSetVariableRunner,
    createTransformRunner: () => createTransformRunner,
    createWorkflowDownstreamSelector: () => createWorkflowDownstreamSelector,
    defaultGenerateId: () => defaultGenerateId,
    describeConditionTree: () => describeConditionTree,
    detectResponseBody: () => detectResponseBody,
    emptyConditionGroup: () => emptyConditionGroup,
    evaluateAssertions: () => evaluateAssertions,
    evaluateCondition: () => runConditionExpression,
    evaluateExtractions: () => evaluateExtractions,
    evaluateJsonPath: () => evaluateJsonPath,
    executeWorkflow: () => executeWorkflow,
    extractSnapshotCookie: () => extractSnapshotCookie,
    extractStatusValue: () => extractStatusValue,
    formatAssertionFailures: () => formatAssertionFailures,
    generateRefId: () => generateRefId,
    inferDependencies: () => inferDependencies,
    isHttpFailure: () => isHttpFailure,
    isTruncatedSnapshot: () => isTruncatedSnapshot,
    isValidRefId: () => isValidRefId,
    jsonDeepEqual: () => jsonDeepEqual,
    matchDownstreamUpstreams: () => matchDownstreamUpstreams,
    mergeVariableScopes: () => mergeVariableScopes,
    migrateConditionRules: () => migrateConditionRules,
    operatorNeedsRight: () => operatorNeedsRight,
    parseConditionRules: () => parseConditionRules,
    parseConditionTree: () => parseConditionTree,
    parseCookieHeader: () => parseCookieHeader,
    parseCsv: () => parseCsv,
    parseJsonPath: () => parseJsonPath,
    parseRightValue: () => parseRightValue,
    readResponseHeader: () => readResponseHeader,
    renderTemplate: () => renderTemplate,
    resolveAssertionRules: () => resolveAssertionRules,
    resolveAssignmentValue: () => resolveAssignmentValue,
    resolveCookieDecision: () => resolveCookieDecision,
    resolveCsvDelimiter: () => resolveCsvDelimiter,
    resolveHeaderFidelityPlan: () => resolveHeaderFidelityPlan,
    resolveLoopExecutionOptions: () => resolveLoopExecutionOptions,
    resolveLoopItems: () => resolveLoopItems,
    resolveLoopMaxIterations: () => resolveLoopMaxIterations,
    resolveScriptTimeoutMs: () => resolveScriptTimeoutMs,
    runPostScript: () => runPostScript,
    runPreScript: () => runPreScript,
    runWorkflow: () => runWorkflow,
    sanitizeJson: () => sanitizeJson,
    startNodeRunner: () => startNodeRunner,
    stripBrowserOnlyHeaders: () => stripBrowserOnlyHeaders,
    updateNodeRunSnapshot: () => updateNodeRunSnapshot,
    validateConditionTree: () => validateConditionTree,
    validateJsonSchemaLite: () => validateJsonSchemaLite,
    validateWorkflowGraph: () => validateWorkflowGraph,
    withNormalizedRequestCookies: () => withNormalizedRequestCookies
  });

  // flow-engine/src/types.ts
  var asWorkflowId = (value) => value;
  var asRunId = (value) => value;
  var asNodeId = (value) => value;
  var asEdgeId = (value) => value;
  var HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

  // flow-engine/src/host-env.ts
  var injectedTimers;
  var injectedUuid;
  function setHostTimers(timers) {
    injectedTimers = timers;
  }
  function resolveTimers() {
    if (injectedTimers !== void 0) return injectedTimers;
    const globalThisTimers = globalThis;
    if (typeof globalThisTimers.setTimeout === "function") {
      return {
        setTimeout: (callback, ms) => globalThisTimers.setTimeout(callback, ms),
        clearTimeout: (handle) => globalThisTimers.clearTimeout?.(handle)
      };
    }
    throw new Error("\u5B9A\u65F6\u5668\u4E0D\u53EF\u7528\uFF1A\u5F53\u524D\u5BBF\u4E3B\u672A\u63D0\u4F9B setTimeout \u4E14\u672A\u6CE8\u5165\u5BBF\u4E3B\u5B9A\u65F6\u5668\u5B9E\u73B0");
  }
  function hostSetTimeout(callback, ms) {
    return resolveTimers().setTimeout(callback, ms);
  }
  function hostClearTimeout(handle) {
    resolveTimers().clearTimeout(handle);
  }
  function fallbackRandomUuid() {
    const hex = "0123456789abcdef";
    let out = "";
    for (let index = 0; index < 36; index++) {
      if (index === 8 || index === 13 || index === 18 || index === 23) {
        out += "-";
      } else if (index === 14) {
        out += "4";
      } else if (index === 19) {
        out += hex[Math.floor(Math.random() * 4) + 8];
      } else {
        out += hex[Math.floor(Math.random() * 16)];
      }
    }
    return out;
  }
  function hostRandomUuid() {
    if (injectedUuid !== void 0) return injectedUuid();
    const cryptoGlobal = globalThis.crypto;
    if (typeof cryptoGlobal?.randomUUID === "function") return cryptoGlobal.randomUUID();
    return fallbackRandomUuid();
  }

  // flow-engine/src/executor.ts
  var defaultGenerateId = () => hostRandomUuid();
  function createRunId(gen) {
    return asRunId((gen ?? defaultGenerateId)());
  }
  var RUN_STATUS_TRANSITIONS = {
    running: ["success", "failed", "cancelled"],
    success: [],
    failed: [],
    cancelled: []
  };
  var NODE_STATUS_TRANSITIONS = {
    pending: ["running", "skipped"],
    running: ["success", "failed", "skipped"],
    success: [],
    failed: [],
    skipped: []
  };
  var IllegalTransitionError = class extends Error {
    constructor(kind, from, to) {
      const label = kind === "run" ? "\u8FD0\u884C\u72B6\u6001" : "\u8282\u70B9\u72B6\u6001";
      super(`\u975E\u6CD5\u7684${label}\u8FC1\u79FB\uFF1A${from} \u2192 ${to}`);
      this.kind = kind;
      this.from = from;
      this.to = to;
      this.name = "IllegalTransitionError";
    }
  };
  function assertRunTransition(from, to) {
    if (!(RUN_STATUS_TRANSITIONS[from] ?? []).includes(to)) {
      throw new IllegalTransitionError("run", from, to);
    }
  }
  function assertNodeTransition(from, to) {
    if (!NODE_STATUS_TRANSITIONS[from].includes(to)) {
      throw new IllegalTransitionError("node", from, to);
    }
  }
  var RunStatusMachine = class {
    #status;
    constructor(initial = "running") {
      this.#status = initial;
    }
    /** 当前状态 */
    get status() {
      return this.#status;
    }
    /**
     * 是否已进入终态（success / failed / cancelled / interrupted）。
     * 'interrupted' 不是迁移表键（见 RUN_STATUS_TRANSITIONS 说明），按空目标表
     * 兜底——以中断态起步的机器同样视为已终结。
     */
    get finished() {
      return (RUN_STATUS_TRANSITIONS[this.#status] ?? []).length === 0;
    }
    /**
     * 迁移到目标状态。
     * @returns 目标状态（便于链式记录）
     * @throws IllegalTransitionError 迁移不在迁移表内时
     */
    transition(next) {
      assertRunTransition(this.#status, next);
      this.#status = next;
      return next;
    }
  };
  var NodeStatusMachine = class {
    #status = "pending";
    /** 当前状态 */
    get status() {
      return this.#status;
    }
    /** 是否已执行完毕（success / failed）或被跳过（skipped），即不再是 pending */
    get settled() {
      return this.#status !== "pending";
    }
    /**
     * 迁移到目标状态。
     * @returns 目标状态
     * @throws IllegalTransitionError 迁移不在迁移表内时
     */
    transition(next) {
      assertNodeTransition(this.#status, next);
      this.#status = next;
      return next;
    }
  };
  function validateWorkflowGraph(nodes, edges) {
    const errors = [];
    const nodeIds = /* @__PURE__ */ new Set();
    for (const node of nodes) {
      if (nodeIds.has(node.id)) {
        errors.push(`\u5B58\u5728\u91CD\u590D\u7684\u8282\u70B9 id\uFF1A${node.id}`);
        continue;
      }
      nodeIds.add(node.id);
    }
    const refKeys = /* @__PURE__ */ new Set();
    for (const node of nodes) {
      if (typeof node.refId !== "string" || node.refId === "") continue;
      if (refKeys.has(node.refId)) {
        errors.push(`\u5B58\u5728\u91CD\u590D\u7684\u8282\u70B9\u5F15\u7528\u77ED\u7801 refId\uFF1A${node.refId}`);
        continue;
      }
      refKeys.add(node.refId);
    }
    const startCount = nodes.filter((node) => node.type === "start").length;
    if (startCount === 0) errors.push("\u7F3A\u5C11\u5F00\u59CB\u8282\u70B9");
    if (startCount > 1) errors.push(`\u5B58\u5728\u591A\u4E2A\u5F00\u59CB\u8282\u70B9\uFF08${startCount} \u4E2A\uFF09\uFF0C\u53EA\u80FD\u4FDD\u7559\u4E00\u4E2A`);
    const stickyIds = new Set(
      nodes.filter((node) => node.type === "stickyNote").map((node) => node.id)
    );
    for (const edge of edges) {
      if (!nodeIds.has(edge.source)) {
        errors.push(`\u8FDE\u7EBF ${edge.id} \u5F15\u7528\u4E86\u4E0D\u5B58\u5728\u7684\u6E90\u8282\u70B9\uFF1A${edge.source}`);
      }
      if (!nodeIds.has(edge.target)) {
        errors.push(`\u8FDE\u7EBF ${edge.id} \u5F15\u7528\u4E86\u4E0D\u5B58\u5728\u7684\u76EE\u6807\u8282\u70B9\uFF1A${edge.target}`);
      }
      if (stickyIds.has(edge.source) || stickyIds.has(edge.target)) {
        errors.push(
          `\u8FDE\u7EBF ${edge.id} \u8FDE\u63A5\u4E86\u4FBF\u7B7E\u8282\u70B9\uFF1A\u4FBF\u7B7E\u4E0D\u53C2\u4E0E\u8FDE\u7EBF\uFF08${edge.source} \u2192 ${edge.target}\uFF09`
        );
      }
    }
    return errors;
  }
  function aggregateInputs(upstreamOutputs) {
    const ids = Object.keys(upstreamOutputs);
    if (ids.length === 0) return null;
    if (ids.length === 1) return upstreamOutputs[ids[0]];
    return { ...upstreamOutputs };
  }
  function buildTemplateContext(nodeOutputs, input = null, variables, env) {
    const context = { node: { ...nodeOutputs }, input };
    if (variables !== void 0) {
      context.var = { ...variables };
    }
    if (env !== void 0) {
      context.env = { ...env };
    }
    return context;
  }
  var startNodeRunner = async () => null;
  function buildRunRecordShell(summary, trigger = "manual") {
    const shell = {
      workflowId: summary.workflowId,
      status: summary.status,
      trigger,
      nodeRuns: summary.nodeRuns
    };
    if (summary.error !== void 0) shell.error = summary.error;
    return shell;
  }
  var SKIPPED_NODE_RUN = () => ({
    status: "skipped",
    input: null,
    output: null,
    startedAt: 0,
    durationMs: 0
  });
  function toErrorMessage(error) {
    if (error instanceof Error) return error.message;
    return String(error);
  }
  function resolveRunner(node, options) {
    const explicit = options.runners?.[node.type];
    if (explicit) return explicit;
    if (node.type === "start") return startNodeRunner;
    return options.defaultRunner;
  }
  function normalizeFailPolicy(value) {
    return value === "continue" ? "continue" : "stop";
  }
  var DEFAULT_MAX_NODE_CONCURRENCY = 4;
  function normalizeMaxNodeConcurrency(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
      return DEFAULT_MAX_NODE_CONCURRENCY;
    }
    return Math.floor(value);
  }
  function resolveNodeFailPolicy(node, defaultPolicy) {
    const configured = node.config.failPolicy;
    if (configured === "stop" || configured === "continue") return configured;
    return defaultPolicy;
  }
  async function runWithRetry(runner, node, input, context) {
    if (node.type === "loop" || node.type === "delay") return runner(node, input, context);
    const retry = node.config.retry;
    const attempts = retry && Number.isFinite(retry.maxAttempts) && retry.maxAttempts >= 1 ? Math.min(5, Math.floor(retry.maxAttempts)) : 1;
    const base = retry && Number.isFinite(retry.backoffMs) && retry.backoffMs > 0 ? Math.min(3e4, Math.floor(retry.backoffMs)) : 0;
    const rawMultiplier = retry?.multiplier;
    const multiplier = typeof rawMultiplier === "number" && Number.isFinite(rawMultiplier) && rawMultiplier >= 1 ? Math.min(4, rawMultiplier) : 2;
    for (let attempt = 1; ; attempt++) {
      try {
        return await runner(node, input, context);
      } catch (error) {
        if (attempt >= attempts || context.signal?.aborted) throw error;
        const waitMs = Math.min(3e4, base * multiplier ** (attempt - 1));
        if (waitMs <= 0) continue;
        await new Promise((resolve, reject) => {
          const timer = hostSetTimeout(() => {
            context.signal?.removeEventListener("abort", onAbort);
            resolve();
          }, waitMs);
          const onAbort = () => {
            hostClearTimeout(timer);
            context.signal?.removeEventListener("abort", onAbort);
            reject(new Error("[cancelled] \u91CD\u8BD5\u7B49\u5F85\u88AB\u53D6\u6D88"));
          };
          context.signal?.addEventListener("abort", onAbort, { once: true });
          if (context.signal?.aborted) onAbort();
        });
      }
    }
  }
  function collectUpstreamOutputs(nodeId, edges, outputs, refKeyOf) {
    const upstream = {};
    for (const edge of edges) {
      if (edge.target !== nodeId) continue;
      if (Object.prototype.hasOwnProperty.call(upstream, edge.source)) continue;
      if (!outputs.has(edge.source)) continue;
      upstream[refKeyOf(edge.source)] = outputs.get(edge.source);
    }
    return upstream;
  }
  function computeUpstreamClosure(nodes, edges, fromNodeId) {
    const known = new Set(nodes.map((node) => node.id));
    const reverse = /* @__PURE__ */ new Map();
    for (const edge of edges) {
      if (!known.has(edge.source) || !known.has(edge.target)) continue;
      const list = reverse.get(edge.target);
      if (list === void 0) reverse.set(edge.target, [edge.source]);
      else if (!list.includes(edge.source)) list.push(edge.source);
    }
    const closure = [];
    const seen = /* @__PURE__ */ new Set([fromNodeId]);
    const frontier = [fromNodeId];
    while (frontier.length > 0) {
      const current = frontier.shift();
      for (const upstream of reverse.get(current) ?? []) {
        if (seen.has(upstream)) continue;
        seen.add(upstream);
        closure.push(upstream);
        frontier.push(upstream);
      }
    }
    return closure;
  }
  function isRunnable(nodeId, edges, statuses) {
    for (const edge of edges) {
      if (edge.target !== nodeId) continue;
      const machine = statuses.get(edge.source);
      if (!machine || machine.status !== "success" && machine.status !== "failed") return false;
    }
    return true;
  }
  async function executeWorkflow(workflow, options = {}) {
    const legacyFailPolicy = options.failPolicy;
    if (legacyFailPolicy !== void 0 && legacyFailPolicy !== "stop") {
      throw new Error(
        `failPolicy "${legacyFailPolicy}" \u5C1A\u672A\u5B9E\u73B0\uFF08'continue' \u7B56\u7565\u8BA1\u5212\u4E8E M5-T4 \u63A5\u5165\uFF09`
      );
    }
    const defaultFailPolicy = normalizeFailPolicy(options.defaultFailPolicy);
    const runId = createRunId(options.generateId);
    const signal = options.signal;
    const validationErrors = validateWorkflowGraph(workflow.nodes, workflow.edges);
    if (validationErrors.length > 0) {
      const summary2 = {
        runId,
        workflowId: workflow.id,
        status: "failed",
        error: validationErrors.join("\uFF1B"),
        nodeRuns: {}
      };
      options.onRunFinish?.(summary2);
      return summary2;
    }
    const statuses = /* @__PURE__ */ new Map();
    const nodeRuns = /* @__PURE__ */ new Map();
    const outputs = /* @__PURE__ */ new Map();
    const nodeById = /* @__PURE__ */ new Map();
    for (const node of workflow.nodes) {
      statuses.set(node.id, new NodeStatusMachine());
      nodeById.set(node.id, node);
    }
    const refKeyOf = (id) => nodeById.get(id)?.refId ?? id;
    const startNode = workflow.nodes.find((node) => node.type === "start");
    let queue = [startNode];
    let enqueued = /* @__PURE__ */ new Set([startNode.id]);
    const resume = options.resume;
    if (resume !== void 0) {
      const fromNode = workflow.nodes.find((node) => node.id === resume.fromNode);
      if (fromNode === void 0) {
        const summary2 = {
          runId,
          workflowId: workflow.id,
          status: "failed",
          error: `\u91CD\u8DD1\u8D77\u70B9\u8282\u70B9\u4E0D\u5B58\u5728\u4E8E\u5F53\u524D\u6D41\u7A0B\uFF1A${resume.fromNode}\uFF08\u6D41\u7A0B\u53EF\u80FD\u5728\u6E90\u8FD0\u884C\u540E\u5DF2\u6539\u7248\uFF09`,
          nodeRuns: {}
        };
        options.onRunFinish?.(summary2);
        return summary2;
      }
      const closure = computeUpstreamClosure(workflow.nodes, workflow.edges, resume.fromNode);
      const missing = closure.filter(
        (id) => !Object.prototype.hasOwnProperty.call(resume.outputs, id)
      );
      if (missing.length > 0) {
        const summary2 = {
          runId,
          workflowId: workflow.id,
          status: "failed",
          error: `\u4E0A\u6E38\u8282\u70B9\u5728\u6E90\u8FD0\u884C\u4E2D\u65E0\u6210\u529F\u8F93\u51FA\uFF0C\u65E0\u6CD5\u4ECE ${resume.fromNode} \u91CD\u8DD1\uFF1A${missing.join("\u3001")}`,
          nodeRuns: {}
        };
        options.onRunFinish?.(summary2);
        return summary2;
      }
      for (const id of closure) {
        const machine = statuses.get(id);
        machine.transition("running");
        machine.transition("success");
        const output = resume.outputs[id];
        outputs.set(id, output);
        const snapshot = resume.nodeRuns[id];
        nodeRuns.set(
          id,
          snapshot ?? {
            status: "success",
            input: null,
            output,
            startedAt: Date.now(),
            durationMs: 0
          }
        );
      }
      queue = [fromNode];
      enqueued = /* @__PURE__ */ new Set([resume.fromNode, ...closure]);
    }
    let failureError;
    let cancelled = false;
    const resolveVariables = () => {
      const raw = options.variables;
      return typeof raw === "function" ? raw() : raw;
    };
    const resolveEnv = () => {
      const raw = options.env;
      return typeof raw === "function" ? raw() : raw;
    };
    const scheduleDownstream = (sourceNode, sourceOutput) => {
      let selection = "all";
      if (options.selectDownstream) {
        selection = options.selectDownstream(sourceNode, sourceOutput);
      }
      for (const edge of workflow.edges) {
        if (edge.source !== sourceNode.id) continue;
        if (selection !== "all" && !selection.includes(edge.target)) continue;
        if (enqueued.has(edge.target)) continue;
        if (!isRunnable(edge.target, workflow.edges, statuses)) continue;
        enqueued.add(edge.target);
        queue.push(nodeById.get(edge.target));
      }
    };
    const maxConcurrency = normalizeMaxNodeConcurrency(options.maxNodeConcurrency);
    const recordSlot = (slot, nodeError, output) => {
      const durationMs = (slot.settledAt ?? Date.now()) - slot.startedAt;
      if (nodeError === void 0) {
        slot.machine.transition("success");
        outputs.set(slot.node.id, output);
        const record2 = {
          status: "success",
          input: slot.input,
          output,
          startedAt: slot.startedAt,
          durationMs,
          // M13-T9：runner 写入的快照附加字段（loop 逐迭代明细）原样并入；
          // 未写入时无该字段（向后兼容，既有快照形状不变）
          ...slot.runContext.snapshotExtras
        };
        nodeRuns.set(slot.node.id, record2);
        options.onNodeFinish?.(slot.node, record2);
        return;
      }
      slot.machine.transition("failed");
      const record = {
        status: "failed",
        input: slot.input,
        output: null,
        error: nodeError,
        startedAt: slot.startedAt,
        durationMs,
        // M13-T9：失败结算同样并入快照附加字段（如 loop 节点失败时已结算轮次
        // 的逐迭代明细——失败轮之前的调试数据不因节点失败而丢失）
        ...slot.runContext.snapshotExtras
      };
      nodeRuns.set(slot.node.id, record);
      options.onNodeFinish?.(slot.node, record);
      if (failureError === void 0) {
        failureError = `\u8282\u70B9 ${slot.node.id} \u6267\u884C\u5931\u8D25\uFF1A${nodeError}`;
      }
    };
    while (queue.length > 0) {
      if (signal?.aborted) {
        cancelled = true;
        break;
      }
      const batch = queue.splice(0, maxConcurrency);
      let launchAborted = false;
      const slots = [];
      const pending = [];
      for (const node of batch) {
        if (signal?.aborted) {
          launchAborted = true;
          break;
        }
        const machine = statuses.get(node.id);
        const input = aggregateInputs(
          collectUpstreamOutputs(node.id, workflow.edges, outputs, refKeyOf)
        );
        machine.transition("running");
        const startedAt = Date.now();
        options.onNodeStart?.(node, input);
        if (options.pinnedOutputs !== void 0 && Object.prototype.hasOwnProperty.call(options.pinnedOutputs, node.id) && options.pinnedOutputs[node.id] !== void 0) {
          const slot2 = {
            node,
            machine,
            input,
            startedAt,
            // runContext 占位：pinned 槽位 launch 期已记录（recorded），后续不读
            runContext: {
              runId,
              signal,
              nodeCtx: { nodeOutputs: {}, templateContext: { node: {}, input } }
            },
            output: options.pinnedOutputs[node.id],
            recorded: true
          };
          machine.transition("success");
          outputs.set(node.id, slot2.output);
          const record = {
            status: "success",
            input,
            output: slot2.output,
            startedAt,
            durationMs: 0
          };
          nodeRuns.set(node.id, record);
          options.onNodeFinish?.(node, record);
          slots.push(slot2);
          continue;
        }
        const nodeOutputs = {};
        for (const [id, value] of outputs) nodeOutputs[refKeyOf(id)] = value;
        const slot = {
          node,
          machine,
          input,
          startedAt,
          runContext: {
            runId,
            signal,
            nodeCtx: {
              nodeOutputs,
              // M7-T2：variables 存在时并入 templateContext.var（未传保持既有形状）；
              // M7-T1：variables 为供给函数时逐节点取当前值（运行期写入可见）；
              // M10-T4：env 快照存在时并入 templateContext.env（{{ env.key }} 引用）；
              // M14-T3：env 允许供给函数形态（脚本写回的运行快照更新逐节点可见）
              templateContext: buildTemplateContext(
                nodeOutputs,
                input,
                resolveVariables(),
                resolveEnv()
              ),
              // M15-T2：runner 手持内部 id 定位输出表（setVariable from='node'）时换算
              refKeyOf
            }
          }
        };
        const runner = resolveRunner(node, options);
        if (!runner) {
          slot.error = `\u6682\u4E0D\u652F\u6301\u7684\u8282\u70B9\u7C7B\u578B\uFF1A${node.type}`;
          slot.settledAt = Date.now();
        } else {
          slot.raw = runWithRetry(runner, node, input, slot.runContext);
          void slot.raw.then(
            (output) => {
              slot.output = output;
              slot.settledAt = Date.now();
            },
            (error) => {
              slot.error = toErrorMessage(error);
              slot.settledAt = Date.now();
            }
          );
          pending.push(slot);
        }
        slots.push(slot);
      }
      if (pending.length === 1) {
        try {
          await pending[0].raw;
        } catch {
        }
      } else if (pending.length > 1) {
        await Promise.all(
          pending.map(
            (slot) => slot.raw.then(
              () => void 0,
              () => void 0
            )
          )
        );
      }
      for (const slot of slots) {
        if (slot.recorded) continue;
        recordSlot(slot, slot.error, slot.error === void 0 ? slot.output : null);
      }
      if (launchAborted || signal?.aborted) {
        cancelled = true;
        break;
      }
      let stopRun = false;
      for (const slot of slots) {
        if (slot.error === void 0) {
          scheduleDownstream(slot.node, slot.output);
        } else if (resolveNodeFailPolicy(slot.node, defaultFailPolicy) === "continue") {
          scheduleDownstream(slot.node, null);
        } else {
          stopRun = true;
          break;
        }
      }
      if (stopRun) break;
    }
    for (const node of workflow.nodes) {
      if (node.type === "stickyNote") continue;
      const machine = statuses.get(node.id);
      if (machine.status === "pending") {
        machine.transition("skipped");
        const nested = options.nestedNodeRun?.(node);
        nodeRuns.set(node.id, nested ?? SKIPPED_NODE_RUN());
      }
    }
    const status = cancelled ? "cancelled" : failureError !== void 0 ? "failed" : "success";
    const summary = {
      runId,
      workflowId: workflow.id,
      status,
      nodeRuns: {}
    };
    for (const [id, record] of nodeRuns) summary.nodeRuns[id] = record;
    if (status === "failed") summary.error = failureError;
    if (status === "cancelled") summary.error = "\u8FD0\u884C\u5DF2\u88AB\u53D6\u6D88";
    options.onRunFinish?.(summary);
    return summary;
  }

  // flow-engine/src/script.ts
  var SCRIPT_PARAM_NAME = {
    pre: "input",
    post: "response"
  };
  var SANDBOX_DEADLINE_PARAM = "__deadline";
  var SANDBOX_CHECK_PARAM = "__checkDeadline";
  var SCRIPT_ENV_PARAM_NAME = "env";
  var DEFAULT_SCRIPT_TIMEOUT_MS = 5e3;
  var PRE_OVERRIDE_KEYS = ["url", "headers", "body", "timeoutMs"];
  var MODE_LABEL = {
    pre: "\u524D\u7F6E\u5904\u7406\u811A\u672C",
    post: "\u540E\u7F6E\u5904\u7406\u811A\u672C"
  };
  var DEADLINE_EXCEEDED = Object.freeze({ __reqflowDeadlineExceeded: true });
  var POLLUTING_KEYS = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
  function createEnvScriptParam(snapshot) {
    const state = { ...snapshot ?? {} };
    for (const key of POLLUTING_KEYS) {
      if (Object.prototype.hasOwnProperty.call(state, key)) delete state[key];
    }
    const writes = /* @__PURE__ */ new Map();
    const env = new Proxy(state, {
      set(target, prop, newValue) {
        if (typeof prop !== "string") {
          return Reflect.set(target, prop, newValue);
        }
        if (POLLUTING_KEYS.has(prop)) {
          throw new Error(`env \u4E0D\u5141\u8BB8\u8D4B\u503C\u4FDD\u7559\u952E\u300C${prop}\u300D\uFF08\u539F\u578B\u6C61\u67D3\u9632\u62A4\uFF09`);
        }
        const cleaned = sanitizeJson(newValue);
        if (!cleaned.ok) {
          throw new Error(`env \u8D4B\u503C\u5FC5\u987B\u662F\u53EF\u5B89\u5168\u4F20\u9012\u7684 JSON \u6570\u636E\uFF1A${cleaned.reason}`);
        }
        if (cleaned.value === void 0) {
          target[prop] = void 0;
          return true;
        }
        writes.set(prop, cleaned.value);
        target[prop] = cleaned.value;
        return true;
      },
      deleteProperty() {
        throw new Error("env \u4E0D\u652F\u6301 delete \u64CD\u4F5C\uFF08\u5199\u56DE\u4EC5\u652F\u6301\u8D4B\u503C\uFF1B\u5982\u9700\u6E05\u9664\u8BF7\u5728\u7BA1\u7406\u9875\u7F16\u8F91\u73AF\u5883\u96C6\u5408\uFF09");
      },
      setPrototypeOf() {
        return false;
      }
    });
    return {
      value: env,
      takeWrites() {
        if (writes.size === 0) return void 0;
        const table = {};
        for (const [key, value] of writes) table[key] = value;
        writes.clear();
        return table;
      }
    };
  }
  function toErrorMessage2(error) {
    if (error instanceof Error) {
      return error.name === "Error" ? error.message : `${error.name}: ${error.message}`;
    }
    return String(error);
  }
  function isCspEvalError(error) {
    return error instanceof Error && error.name === "EvalError";
  }
  function resolveScriptTimeoutMs(opts) {
    const raw = opts?.timeoutMs;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      return DEFAULT_SCRIPT_TIMEOUT_MS;
    }
    return raw;
  }
  function compileScript(source, mode = "pre") {
    const label = MODE_LABEL[mode];
    let factory;
    try {
      factory = new Function(
        SANDBOX_DEADLINE_PARAM,
        SANDBOX_CHECK_PARAM,
        SCRIPT_PARAM_NAME[mode],
        SCRIPT_ENV_PARAM_NAME,
        `"use strict";
${source}`
      );
    } catch (error) {
      if (isCspEvalError(error)) {
        return {
          ok: false,
          error: {
            kind: "blocked",
            message: `${label}\u88AB\u5185\u5BB9\u5B89\u5168\u7B56\u7565\uFF08CSP\uFF09\u62E6\u622A\uFF0C\u65E0\u6CD5\u7F16\u8BD1\u6267\u884C\uFF1A${toErrorMessage2(error)}\u3002\u5F53\u524D\u4E0A\u4E0B\u6587\u7981\u6B62 eval \u7CFB\u811A\u672C\u6C42\u503C\uFF1BM9-T2 \u8D77\u811A\u672C\u7ECF\u6C99\u7BB1\u901A\u9053\uFF08offscreen + sandbox iframe\uFF09\u6267\u884C\uFF0C\u82E5\u770B\u5230\u6B64\u9519\u8BEF\u8BF4\u660E\u8BE5\u6B21\u6267\u884C\u672A\u8D70\u6C99\u7BB1\u901A\u9053\uFF0C\u8BF7\u68C0\u67E5\u6269\u5C55\u7684\u6C99\u7BB1\u914D\u7F6E\u3002`,
            cause: error
          }
        };
      }
      return {
        ok: false,
        error: {
          kind: "syntax",
          message: `${label}\u8BED\u6CD5\u9519\u8BEF\uFF1A${toErrorMessage2(error)}`,
          cause: error
        }
      };
    }
    return {
      ok: true,
      fn: (param, sandbox, env) => factory(sandbox.deadline, sandbox.checkDeadline, param, env)
    };
  }
  function executeCompiled(fn, param, timeoutMs, label, env) {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    const checkDeadline = () => {
      if (Date.now() > deadline) throw DEADLINE_EXCEEDED;
    };
    let value;
    try {
      value = fn(param, { deadline, checkDeadline }, env);
    } catch (error) {
      if (error === DEADLINE_EXCEEDED) {
        return {
          ok: false,
          error: {
            kind: "timeout",
            message: `${label}\u901A\u8FC7 ${SANDBOX_CHECK_PARAM}() \u4E3B\u52A8\u4E2D\u65AD\uFF1A\u5DF2\u8D85\u8FC7\u622A\u6B62\u65F6\u95F4\uFF08\u4E0A\u9650 ${timeoutMs}ms\uFF09\u3002\u811A\u672C\u5728\u54E8\u5175\u629B\u51FA\u524D\u4EA7\u751F\u7684\u526F\u4F5C\u7528\u65E0\u6CD5\u56DE\u6EDA\u3002`
          }
        };
      }
      return {
        ok: false,
        error: {
          kind: "runtime",
          message: `${label}\u8FD0\u884C\u65F6\u9519\u8BEF\uFF1A${toErrorMessage2(error)}`,
          cause: error
        }
      };
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed > timeoutMs) {
      return {
        ok: false,
        error: {
          kind: "timeout",
          message: `${label}\u6267\u884C\u8F6F\u8D85\u65F6\uFF1A\u5B9E\u9645\u8017\u65F6 ${elapsed}ms \u8D85\u8FC7\u4E0A\u9650 ${timeoutMs}ms\u3002\u540C\u6B65\u811A\u672C\u65E0\u6CD5\u88AB\u5F3A\u5236\u4E2D\u65AD\uFF0C\u811A\u672C\u5DF2\u5B8C\u6574\u8DD1\u5B8C\u3001\u671F\u95F4\u7684\u526F\u4F5C\u7528\u65E0\u6CD5\u56DE\u6EDA\uFF1B\u5EFA\u8BAE\u5728\u957F\u5FAA\u73AF\u5185\u8C03\u7528 ${SANDBOX_CHECK_PARAM}() \u4E3B\u52A8\u4E2D\u65AD\u3002`
        }
      };
    }
    return { ok: true, value };
  }
  function sanitizeJson(value) {
    try {
      return sanitizeWalk(value, /* @__PURE__ */ new WeakSet());
    } catch (error) {
      return { ok: false, reason: `\u8BFB\u53D6\u6570\u636E\u5931\u8D25\uFF1A${toErrorMessage2(error)}` };
    }
  }
  function sanitizeWalk(value, seen) {
    if (value === null) return { ok: true, value: null };
    const kind = typeof value;
    if (kind === "string" || kind === "number" || kind === "boolean") {
      return { ok: true, value };
    }
    if (kind === "undefined") {
      return { ok: true, value: void 0 };
    }
    if (kind === "function" || kind === "symbol" || kind === "bigint") {
      return { ok: false, reason: `\u975E JSON \u7C7B\u578B\uFF1A${kind}` };
    }
    const source = value;
    if (seen.has(source)) {
      return { ok: false, reason: "\u5FAA\u73AF\u5F15\u7528" };
    }
    if (Array.isArray(source)) {
      seen.add(source);
      const out2 = [];
      for (const item of source) {
        const walked = sanitizeWalk(item, seen);
        if (!walked.ok) return walked;
        out2.push(walked.value === void 0 ? null : walked.value);
      }
      seen.delete(source);
      return { ok: true, value: out2 };
    }
    const proto = Object.getPrototypeOf(source);
    if (proto !== Object.prototype && proto !== null) {
      let name = "object";
      try {
        name = String(source.constructor?.name ?? "object");
      } catch {
      }
      return { ok: false, reason: `\u975E JSON \u5BF9\u8C61\u7C7B\u578B\uFF1A${name}\uFF08\u8BF7\u5148\u8F6C\u6362\u4E3A\u666E\u901A\u5BF9\u8C61 / \u6570\u7EC4\uFF09` };
    }
    seen.add(source);
    const out = {};
    for (const [key, item] of Object.entries(source)) {
      if (POLLUTING_KEYS.has(key)) continue;
      const walked = sanitizeWalk(item, seen);
      if (!walked.ok) return walked;
      if (walked.value === void 0) continue;
      out[key] = walked.value;
    }
    seen.delete(source);
    return { ok: true, value: out };
  }
  function toPreOverrides(value) {
    const warnings = [];
    if (value === void 0 || value === null) {
      return { overrides: {}, warnings };
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      warnings.push(`\u524D\u7F6E\u811A\u672C\u8FD4\u56DE\u503C\u4E0D\u662F\u5BF9\u8C61\uFF08${typeof value}\uFF09\uFF0C\u5DF2\u6309\u300C\u4E0D\u4FEE\u6539\u8BF7\u6C42\u300D\u4E22\u5F03`);
      return { overrides: {}, warnings };
    }
    const overrides = {};
    for (const [key, item] of Object.entries(value)) {
      if (!PRE_OVERRIDE_KEYS.includes(key)) {
        warnings.push(`\u5FFD\u7565\u524D\u7F6E\u811A\u672C\u8FD4\u56DE\u7684\u672A\u77E5\u8986\u76D6\u952E\uFF1A${key}`);
        continue;
      }
      overrides[key] = item;
    }
    return { overrides, warnings };
  }
  function runPreScript(source, input, opts) {
    const timeoutMs = resolveScriptTimeoutMs(opts);
    const compiled = compileScript(source, "pre");
    if (!compiled.ok) return compiled;
    const envParam = createEnvScriptParam(opts?.env);
    const safeInput = sanitizeJson(input);
    if (!safeInput.ok) {
      return {
        ok: false,
        error: {
          kind: "runtime",
          message: `\u524D\u7F6E\u811A\u672C\u5165\u53C2\uFF08input\uFF09\u4E0D\u662F\u53EF\u5B89\u5168\u4F20\u9012\u7684 JSON \u6570\u636E\uFF1A${safeInput.reason}`
        }
      };
    }
    const executed = executeCompiled(
      compiled.fn,
      safeInput.value,
      timeoutMs,
      MODE_LABEL.pre,
      envParam.value
    );
    const envWrites = envParam.takeWrites();
    if (!executed.ok) {
      return {
        ok: false,
        error: executed.error,
        ...envWrites !== void 0 ? { envWrites } : {}
      };
    }
    const safeReturn = sanitizeJson(executed.value);
    if (!safeReturn.ok) {
      return {
        ok: false,
        error: {
          kind: "invalid-return",
          message: `\u524D\u7F6E\u811A\u672C\u8FD4\u56DE\u503C\u4E0D\u662F\u5408\u6CD5 JSON\uFF1A${safeReturn.reason}`
        },
        ...envWrites !== void 0 ? { envWrites } : {}
      };
    }
    const { overrides, warnings } = toPreOverrides(safeReturn.value);
    return {
      ok: true,
      value: overrides,
      warnings,
      ...envWrites !== void 0 ? { envWrites } : {}
    };
  }
  function runPostScript(source, response, opts) {
    const timeoutMs = resolveScriptTimeoutMs(opts);
    const compiled = compileScript(source, "post");
    if (!compiled.ok) return compiled;
    const envParam = createEnvScriptParam(opts?.env);
    const safeResponse = sanitizeJson(response);
    if (!safeResponse.ok) {
      return {
        ok: false,
        error: {
          kind: "runtime",
          message: `\u540E\u7F6E\u811A\u672C\u5165\u53C2\uFF08response\uFF09\u4E0D\u662F\u53EF\u5B89\u5168\u4F20\u9012\u7684 JSON \u6570\u636E\uFF1A${safeResponse.reason}`
        }
      };
    }
    const executed = executeCompiled(
      compiled.fn,
      safeResponse.value,
      timeoutMs,
      MODE_LABEL.post,
      envParam.value
    );
    const envWrites = envParam.takeWrites();
    if (!executed.ok) {
      return {
        ok: false,
        error: executed.error,
        ...envWrites !== void 0 ? { envWrites } : {}
      };
    }
    if (executed.value === void 0) {
      const body = safeResponse.value?.body;
      return {
        ok: true,
        value: body === void 0 ? null : body,
        warnings: [],
        ...envWrites !== void 0 ? { envWrites } : {}
      };
    }
    const safeReturn = sanitizeJson(executed.value);
    if (!safeReturn.ok) {
      return {
        ok: false,
        error: {
          kind: "invalid-return",
          message: `\u540E\u7F6E\u811A\u672C\u8FD4\u56DE\u503C\u4E0D\u662F\u5408\u6CD5 JSON\uFF1A${safeReturn.reason}`
        },
        ...envWrites !== void 0 ? { envWrites } : {}
      };
    }
    return {
      ok: true,
      value: safeReturn.value,
      warnings: [],
      ...envWrites !== void 0 ? { envWrites } : {}
    };
  }

  // flow-engine/src/error-class.ts
  var SCRIPT_ERROR_KINDS = [
    "syntax",
    "blocked",
    "runtime",
    "timeout",
    "invalid-return"
  ];
  var ScriptExecutionError = class extends Error {
    /** 底层 ScriptError 的 kind（syntax / blocked / runtime / timeout / invalid-return） */
    kind;
    constructor(error) {
      super(error.message);
      this.name = "ScriptExecutionError";
      this.kind = error.kind;
    }
  };
  var HttpFailureError = class extends Error {
    /** 触发失败的 HTTP 状态码（4xx / 5xx） */
    status;
    /**
     * 被拒绝的归一化响应输出（可选，M13-T1）：HTTP 失败判定发生在后置脚本之前，
     * 失败响应本不进入输出链路——内联试跑（配置抽屉结果区）需要在节点失败的
     * 同时展示状态码与响应体，脚本接线 runner 抛错时把重放归一化响应挂在错误上
     * （形状同 ReplayResponseOutput；是否携带由抛出方决定，历史构造不受影响）。
     */
    response;
    constructor(status, response) {
      super(`HTTP ${status}`);
      this.name = "HttpFailureError";
      this.status = status;
      this.response = response;
    }
  };
  function toMessage(error) {
    if (error instanceof Error) return error.message;
    return String(error);
  }
  function classifyNodeError(error) {
    if (typeof error === "object" && error !== null) {
      const kind = error.kind;
      if (typeof kind === "string" && SCRIPT_ERROR_KINDS.includes(kind)) {
        if (kind === "timeout") return "timeout";
        if (kind === "blocked") return "blocked";
        return "script";
      }
    }
    if (error instanceof HttpFailureError) return "http";
    if (/^HTTP \d{3}$/.test(toMessage(error))) return "http";
    const message = toMessage(error);
    if (message.startsWith("[network]")) return "network";
    if (message.startsWith("[timeout]")) return "timeout";
    if (message.startsWith("[cancelled]")) return "cancelled";
    if (typeof error === "object" && error !== null && error.name === "AbortError") {
      return "cancelled";
    }
    return "unknown";
  }
  function isHttpFailure(output) {
    if (typeof output !== "object" || output === null) return false;
    const status = output.status;
    return typeof status === "number" && status >= 400;
  }

  // flow-engine/src/fake.ts
  function randomInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }
  function pick(list) {
    return list[randomInt(0, list.length - 1)];
  }
  function randomHex(length) {
    let out = "";
    for (let i = 0; i < length; i++) {
      out += Math.floor(Math.random() * 16).toString(16);
    }
    return out;
  }
  var PHONE_PREFIXES = [
    "133",
    "135",
    "136",
    "137",
    "138",
    "139",
    "147",
    "148",
    "149",
    "150",
    "151",
    "152",
    "155",
    "156",
    "157",
    "158",
    "159",
    "165",
    "166",
    "170",
    "171",
    "172",
    "173",
    "175",
    "176",
    "177",
    "178",
    "180",
    "181",
    "182",
    "183",
    "184",
    "185",
    "186",
    "187",
    "188",
    "189",
    "191",
    "193",
    "195",
    "198",
    "199"
  ];
  var NAME_SURNAMES = [
    "\u738B",
    "\u674E",
    "\u5F20",
    "\u5218",
    "\u9648",
    "\u6768",
    "\u9EC4",
    "\u8D75",
    "\u5434",
    "\u5468",
    "\u5F90",
    "\u5B59",
    "\u9A6C",
    "\u6731",
    "\u80E1",
    "\u90ED",
    "\u4F55",
    "\u6797",
    "\u7F57",
    "\u9AD8",
    "\u90D1",
    "\u6881",
    "\u8C22",
    "\u5B8B",
    "\u5510",
    "\u8BB8",
    "\u97E9",
    "\u51AF",
    "\u9093",
    "\u66F9",
    "\u5F6D",
    "\u66FE",
    "\u8096",
    "\u7530",
    "\u8463",
    "\u6F58",
    "\u8881",
    "\u848B",
    "\u8521",
    "\u4F59"
  ];
  var NAME_GIVENS = [
    "\u4F1F",
    "\u82B3",
    "\u5A1C",
    "\u654F",
    "\u9759",
    "\u78CA",
    "\u519B",
    "\u6D0B",
    "\u52C7",
    "\u8273",
    "\u6770",
    "\u6D9B",
    "\u660E",
    "\u8D85",
    "\u971E",
    "\u5E73",
    "\u521A",
    "\u8F89",
    "\u6D01",
    "\u5A77",
    "\u5B50\u6DB5",
    "\u96E8\u6B23",
    "\u6D69\u7136",
    "\u6B23\u6021",
    "\u6893\u8431",
    "\u5B87\u8F69",
    "\u601D\u8FDC",
    "\u68A6\u742A",
    "\u5FD7\u5F3A",
    "\u5EFA\u56FD",
    "\u4E3D\u534E",
    "\u6653\u4E1C",
    "\u5929\u4F51",
    "\u82E5\u66E6",
    "\u4FCA\u6770",
    "\u6167\u654F"
  ];
  var ADDRESS_REGIONS = [
    {
      province: "\u5317\u4EAC\u5E02",
      city: "\u5317\u4EAC\u5E02",
      districts: ["\u671D\u9633\u533A", "\u6D77\u6DC0\u533A", "\u4E1C\u57CE\u533A", "\u897F\u57CE\u533A", "\u4E30\u53F0\u533A"]
    },
    {
      province: "\u4E0A\u6D77\u5E02",
      city: "\u4E0A\u6D77\u5E02",
      districts: ["\u6D66\u4E1C\u65B0\u533A", "\u5F90\u6C47\u533A", "\u9759\u5B89\u533A", "\u6768\u6D66\u533A", "\u95F5\u884C\u533A"]
    },
    {
      province: "\u5E7F\u4E1C\u7701",
      city: "\u6DF1\u5733\u5E02",
      districts: ["\u5357\u5C71\u533A", "\u798F\u7530\u533A", "\u7F57\u6E56\u533A", "\u5B9D\u5B89\u533A", "\u9F99\u5C97\u533A"]
    },
    {
      province: "\u5E7F\u4E1C\u7701",
      city: "\u5E7F\u5DDE\u5E02",
      districts: ["\u5929\u6CB3\u533A", "\u8D8A\u79C0\u533A", "\u6D77\u73E0\u533A", "\u767D\u4E91\u533A", "\u9EC4\u57D4\u533A"]
    },
    {
      province: "\u6D59\u6C5F\u7701",
      city: "\u676D\u5DDE\u5E02",
      districts: ["\u897F\u6E56\u533A", "\u6EE8\u6C5F\u533A", "\u4F59\u676D\u533A", "\u62F1\u5885\u533A", "\u8427\u5C71\u533A"]
    },
    {
      province: "\u6C5F\u82CF\u7701",
      city: "\u5357\u4EAC\u5E02",
      districts: ["\u7384\u6B66\u533A", "\u79E6\u6DEE\u533A", "\u9F13\u697C\u533A", "\u5EFA\u90BA\u533A", "\u6C5F\u5B81\u533A"]
    },
    {
      province: "\u56DB\u5DDD\u7701",
      city: "\u6210\u90FD\u5E02",
      districts: ["\u9526\u6C5F\u533A", "\u9752\u7F8A\u533A", "\u6B66\u4FAF\u533A", "\u6210\u534E\u533A", "\u91D1\u725B\u533A"]
    },
    {
      province: "\u6E56\u5317\u7701",
      city: "\u6B66\u6C49\u5E02",
      districts: ["\u6C5F\u5CB8\u533A", "\u6B66\u660C\u533A", "\u6D2A\u5C71\u533A", "\u6C49\u9633\u533A", "\u785A\u53E3\u533A"]
    },
    {
      province: "\u9655\u897F\u7701",
      city: "\u897F\u5B89\u5E02",
      districts: ["\u96C1\u5854\u533A", "\u7891\u6797\u533A", "\u672A\u592E\u533A", "\u83B2\u6E56\u533A", "\u65B0\u57CE\u533A"]
    },
    {
      province: "\u5C71\u4E1C\u7701",
      city: "\u9752\u5C9B\u5E02",
      districts: ["\u5E02\u5357\u533A", "\u5E02\u5317\u533A", "\u5D02\u5C71\u533A", "\u674E\u6CA7\u533A", "\u57CE\u9633\u533A"]
    }
  ];
  var ADDRESS_STREETS = [
    "\u4EBA\u6C11\u8DEF",
    "\u4E2D\u5C71\u8DEF",
    "\u89E3\u653E\u8DEF",
    "\u5EFA\u8BBE\u8DEF",
    "\u79D1\u6280\u56ED\u8DEF",
    "\u548C\u5E73\u8DEF",
    "\u6587\u5316\u8DEF",
    "\u671D\u9633\u8DEF",
    "\u5E78\u798F\u5927\u9053",
    "\u6EE8\u6C5F\u9053"
  ];
  var PLATE_PROVINCES = [
    "\u4EAC",
    "\u6D25",
    "\u6CAA",
    "\u6E1D",
    "\u5180",
    "\u664B",
    "\u8499",
    "\u8FBD",
    "\u5409",
    "\u9ED1",
    "\u82CF",
    "\u6D59",
    "\u7696",
    "\u95FD",
    "\u8D63",
    "\u9C81",
    "\u8C6B",
    "\u9102",
    "\u6E58",
    "\u7CA4",
    "\u6842",
    "\u743C",
    "\u5DDD",
    "\u8D35",
    "\u4E91",
    "\u85CF",
    "\u9655",
    "\u7518",
    "\u9752",
    "\u5B81",
    "\u65B0"
  ];
  var PLATE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  var IDCARD_AREA_CODES = [
    "110101",
    "110105",
    "310101",
    "310104",
    "440303",
    "440304",
    "330102",
    "330106",
    "320102",
    "510104",
    "420102",
    "610113",
    "370202",
    "350102",
    "430102"
  ];
  var EMAIL_DOMAINS = ["example.com", "example.org", "example.net"];
  function parseIntArg(raw) {
    if (!/^-?\d+$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  }
  function generatePhone() {
    return { value: pick(PHONE_PREFIXES) + String(randomInt(0, 99999999)).padStart(8, "0") };
  }
  function generateName() {
    return { value: pick(NAME_SURNAMES) + pick(NAME_GIVENS) };
  }
  function generateAddress() {
    const region = pick(ADDRESS_REGIONS);
    const streetNo = String(randomInt(1, 999));
    return {
      value: `${region.province}${region.city}${pick(region.districts)}${pick(ADDRESS_STREETS)}${streetNo}\u53F7`
    };
  }
  function generateAvatar() {
    return { value: `https://picsum.photos/seed/${randomHex(6)}/300/300` };
  }
  function generatePlate() {
    let tail = "";
    for (let i = 0; i < 5; i++) {
      const useLetter = Math.random() < 0.4;
      tail += useLetter ? PLATE_LETTERS[randomInt(0, PLATE_LETTERS.length - 1)] : String(randomInt(0, 9));
    }
    return {
      value: pick(PLATE_PROVINCES) + PLATE_LETTERS[randomInt(0, PLATE_LETTERS.length - 1)] + tail
    };
  }
  var IDCARD_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  var IDCARD_CHECK_MAP = "10X98765432";
  function generateIdcard() {
    const area = pick(IDCARD_AREA_CODES);
    const year = randomInt(1970, 2005);
    const month = String(randomInt(1, 12)).padStart(2, "0");
    const day = String(randomInt(1, 28)).padStart(2, "0");
    const sequence = String(randomInt(1, 999)).padStart(3, "0");
    const body = `${area}${year}${month}${day}${sequence}`;
    let sum = 0;
    for (let i = 0; i < 17; i++) {
      sum += Number(body[i]) * IDCARD_WEIGHTS[i];
    }
    return { value: body + IDCARD_CHECK_MAP[sum % 11] };
  }
  function generateEmail() {
    return { value: `${randomHex(8)}@${pick(EMAIL_DOMAINS)}` };
  }
  function generateIp() {
    return {
      value: `${randomInt(1, 254)}.${randomInt(1, 254)}.${randomInt(1, 254)}.${randomInt(1, 254)}`
    };
  }
  function generateNumber(args) {
    if (args.length === 0) {
      return { value: String(randomInt(0, 9999)) };
    }
    if (args.length === 2) {
      const min = parseIntArg(args[0]);
      const max = parseIntArg(args[1]);
      if (min === null || max === null || min > max) {
        return { value: "", warning: "number \u9700\u8981\u4E24\u4E2A\u6574\u6570\u53C2\u6570\u4E14 min <= max\uFF0C\u5982 number(1,100)" };
      }
      return { value: String(randomInt(min, max)) };
    }
    return { value: "", warning: "number \u9700\u8981\u96F6\u4E2A\u6216\u4E24\u4E2A\u53C2\u6570\uFF0C\u5982 number / number(1,100)" };
  }
  function generateUuid() {
    let out = "";
    for (let i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) {
        out += "-";
        continue;
      }
      if (i === 14) {
        out += "4";
        continue;
      }
      if (i === 19) {
        out += "89ab"[randomInt(0, 3)];
        continue;
      }
      out += Math.floor(Math.random() * 16).toString(16);
    }
    return { value: out };
  }
  function generateTimestamp() {
    return { value: String(Date.now()) };
  }
  function generateHex(args) {
    if (args.length === 0) {
      return { value: randomHex(32) };
    }
    if (args.length === 1) {
      const length = parseIntArg(args[0]);
      if (length === null || length < 1 || length > 256) {
        return { value: "", warning: "hex \u9700\u8981\u4E00\u4E2A 1~256 \u7684\u6574\u6570\u957F\u5EA6\u53C2\u6570\uFF0C\u5982 hex(16)" };
      }
      return { value: randomHex(length) };
    }
    return { value: "", warning: "hex \u9700\u8981\u96F6\u4E2A\u6216\u4E00\u4E2A\u53C2\u6570\uFF0C\u5982 hex / hex(16)" };
  }
  var GENERATOR_IMPLS = {
    phone: generatePhone,
    name: generateName,
    address: generateAddress,
    avatar: generateAvatar,
    plate: generatePlate,
    idcard: generateIdcard,
    email: generateEmail,
    number: generateNumber,
    ip: generateIp,
    uuid: generateUuid,
    timestamp: generateTimestamp,
    hex: generateHex
  };
  var FAKE_GENERATORS = [
    { name: "phone", description: "11 \u4F4D\u624B\u673A\u53F7", example: "13912345678" },
    { name: "name", description: "\u4E2D\u6587\u59D3\u540D", example: "\u5F20\u4F1F" },
    {
      name: "address",
      description: "\u4E2D\u6587\u5730\u5740\uFF08\u7701\u5E02\u533A + \u8857\u9053\u95E8\u724C\uFF09",
      example: "\u5E7F\u4E1C\u7701\u6DF1\u5733\u5E02\u5357\u5C71\u533A\u79D1\u6280\u56ED\u8DEF48\u53F7"
    },
    { name: "email", description: "\u90AE\u7BB1\uFF08\u4FDD\u7559\u57DF\uFF0C\u4E0D\u4F1A\u8BEF\u6295\uFF09", example: "a3f9c2d1@example.com" },
    { name: "idcard", description: "18 \u4F4D\u8EAB\u4EFD\u8BC1\u53F7\uFF08\u542B\u5408\u6CD5\u6821\u9A8C\u4F4D\uFF09", example: "110101199003077758" },
    { name: "plate", description: "\u8F66\u724C\u53F7", example: "\u4EACA12345" },
    {
      name: "avatar",
      description: "\u5934\u50CF\u5360\u4F4D\u56FE\u5916\u94FE\uFF08\u9700\u5916\u7F51\u62C9\u53D6\uFF09",
      example: "https://picsum.photos/seed/a3b2c1/300/300"
    },
    { name: "ip", description: "IPv4 \u5730\u5740", example: "203.0.113.88" },
    {
      name: "number",
      description: "\u968F\u673A\u6574\u6570\uFF0C\u53EF\u5E26\u95ED\u533A\u95F4\u53C2\u6570",
      example: "{{ fake.number(1,100) }} \u2192 87"
    },
    {
      name: "hex",
      description: "\u968F\u673A\u5341\u516D\u8FDB\u5236\u4E32\uFF0C\u9ED8\u8BA4 32 \u4F4D\u53EF\u6307\u5B9A\u957F\u5EA6",
      example: "{{ fake.hex(16) }} \u2192 a3f9\u2026"
    },
    { name: "uuid", description: "UUID v4", example: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" },
    { name: "timestamp", description: "\u5F53\u524D\u6BEB\u79D2\u65F6\u95F4\u6233", example: "1730000000000" }
  ];
  var FAKE_GENERATOR_NAMES = FAKE_GENERATORS.map((def) => def.name);
  function generateFake(name, args) {
    const generator = GENERATOR_IMPLS[name];
    if (!generator) {
      return { value: "", warning: `\u672A\u77E5\u7684\u751F\u6210\u5668\uFF1A${name}` };
    }
    return generator(args);
  }

  // flow-engine/src/template.ts
  var UNCLOSED_BRACE_WARNING = '\u672A\u95ED\u5408\u7684 "{{" \u5DF2\u6309\u5B57\u9762\u91CF\u5904\u7406';
  var OPEN_SEQUENCE = "{{";
  var BARE_PATH_PATTERN = /^[A-Za-z_$][\w$-]*(\.[\w$-]+)*$/;
  var ARRAY_INDEX_PATTERN = /^(0|[1-9]\d*)$/;
  function parseRef(content) {
    const dotIndex = content.indexOf(".");
    const root = dotIndex === -1 ? content : content.slice(0, dotIndex);
    const rest = dotIndex === -1 ? "" : content.slice(dotIndex + 1);
    if (root === "input" || root === "$json") {
      return { kind: "input", path: rest };
    }
    if (root === "node") {
      if (rest === "") return null;
      const secondDot = rest.indexOf(".");
      if (secondDot === -1) return { kind: "node", nodeId: rest, path: "" };
      const nodeId = rest.slice(0, secondDot);
      if (nodeId === "") return null;
      return { kind: "node", nodeId, path: rest.slice(secondDot + 1) };
    }
    if (root === "var") {
      if (rest === "") return null;
      const secondDot = rest.indexOf(".");
      if (secondDot === -1) return { kind: "var", name: rest, path: "" };
      const name = rest.slice(0, secondDot);
      if (name === "") return null;
      return { kind: "var", name, path: rest.slice(secondDot + 1) };
    }
    if (root === "env") {
      if (rest === "") return null;
      const secondDot = rest.indexOf(".");
      if (secondDot === -1) return { kind: "env", name: rest, path: "" };
      const name = rest.slice(0, secondDot);
      if (name === "") return null;
      return { kind: "env", name, path: rest.slice(secondDot + 1) };
    }
    if (root === "fake") {
      if (rest === "") return null;
      const match = /^([A-Za-z][\w-]*)(?:\(([^)]*)\))?$/.exec(rest);
      if (!match) return null;
      const name = match[1];
      const args = match[2] === void 0 ? void 0 : match[2].split(",").map((item) => item.trim());
      return { kind: "fake", name, args, path: "" };
    }
    if (BARE_PATH_PATTERN.test(content)) {
      return { kind: "input", path: content };
    }
    return null;
  }
  function parseTemplate(raw) {
    const tokens = [];
    let cursor = 0;
    while (cursor < raw.length) {
      const open = raw.indexOf(OPEN_SEQUENCE, cursor);
      if (open === -1) {
        tokens.push({ kind: "text", value: raw.slice(cursor) });
        break;
      }
      if (open > cursor) {
        tokens.push({ kind: "text", value: raw.slice(cursor, open) });
      }
      const close = raw.indexOf("}}", open + OPEN_SEQUENCE.length);
      if (close === -1) {
        const literal = raw.slice(open);
        const last = tokens[tokens.length - 1];
        if (open > cursor && last && last.kind === "text") {
          last.value += literal;
          last.warning = UNCLOSED_BRACE_WARNING;
        } else {
          tokens.push({ kind: "text", value: literal, warning: UNCLOSED_BRACE_WARNING });
        }
        break;
      }
      const content = raw.slice(open + OPEN_SEQUENCE.length, close).trim();
      tokens.push({ kind: "expression", raw: content, ref: parseRef(content) });
      cursor = close + 2;
    }
    return tokens;
  }
  function resolvePath(root, path) {
    if (path === "") {
      return { found: true, value: root };
    }
    let current = root;
    for (const segment of path.split(".")) {
      if (current === null || typeof current !== "object") {
        return { found: false, value: void 0 };
      }
      if (Array.isArray(current)) {
        if (!ARRAY_INDEX_PATTERN.test(segment)) {
          return { found: false, value: void 0 };
        }
        const index = Number(segment);
        if (index >= current.length) {
          return { found: false, value: void 0 };
        }
        current = current[index];
      } else {
        const record = current;
        if (!Object.prototype.hasOwnProperty.call(record, segment)) {
          return { found: false, value: void 0 };
        }
        current = record[segment];
      }
    }
    return { found: true, value: current };
  }
  function stringifyValue(value) {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  function getNodeRoot(ctx, nodeId) {
    const table = ctx.node;
    if (table === null || typeof table !== "object") {
      return { present: false, value: void 0 };
    }
    const record = table;
    if (!Object.prototype.hasOwnProperty.call(record, nodeId)) {
      return { present: false, value: void 0 };
    }
    return { present: true, value: record[nodeId] };
  }
  function getVarRoot(ctx, name) {
    const table = ctx.var;
    if (table === null || typeof table !== "object") {
      return { present: false, value: void 0 };
    }
    const record = table;
    if (!Object.prototype.hasOwnProperty.call(record, name)) {
      return { present: false, value: void 0 };
    }
    return { present: true, value: record[name] };
  }
  function getEnvRoot(ctx, name) {
    const table = ctx.env;
    if (table === null || typeof table !== "object") {
      return { present: false, value: void 0 };
    }
    const record = table;
    if (!Object.prototype.hasOwnProperty.call(record, name)) {
      return { present: false, value: void 0 };
    }
    return { present: true, value: record[name] };
  }
  var FAKE_RENDER_CACHES = /* @__PURE__ */ new WeakMap();
  function fakeCacheFor(ctx) {
    let cache = FAKE_RENDER_CACHES.get(ctx);
    if (!cache) {
      cache = /* @__PURE__ */ new Map();
      FAKE_RENDER_CACHES.set(ctx, cache);
    }
    return cache;
  }
  function renderTemplate(raw, ctx) {
    const warnings = [];
    const parts = [];
    for (const token of parseTemplate(raw)) {
      if (token.kind === "text") {
        parts.push(token.value);
        if (token.warning) warnings.push(token.warning);
        continue;
      }
      if (!token.ref) {
        warnings.push(`\u672A\u77E5\u7684\u6A21\u677F\u5F15\u7528\uFF1A{{ ${token.raw} }}`);
        continue;
      }
      const ref = token.ref;
      if (ref.kind === "fake") {
        const cache = fakeCacheFor(ctx);
        const cached = cache.get(token.raw);
        if (cached !== void 0) {
          parts.push(cached);
          continue;
        }
        const generated = generateFake(ref.name ?? "", ref.args ?? []);
        if (generated.warning) {
          warnings.push(`\u5047\u6570\u636E\u6A21\u677F\u751F\u6210\u5931\u8D25\uFF1A{{ ${token.raw} }}\uFF08${generated.warning}\uFF09`);
          continue;
        }
        cache.set(token.raw, generated.value);
        parts.push(generated.value);
        continue;
      }
      let rootValue;
      if (ref.kind === "input") {
        rootValue = ctx.input;
      } else if (ref.kind === "var") {
        const varRoot = getVarRoot(ctx, ref.name ?? "");
        if (!varRoot.present) {
          warnings.push(`\u6A21\u677F\u5F15\u7528\u7684\u53D8\u91CF\u4E0D\u5B58\u5728\uFF1A{{ ${token.raw} }}`);
          continue;
        }
        rootValue = varRoot.value;
      } else if (ref.kind === "env") {
        const envRoot = getEnvRoot(ctx, ref.name ?? "");
        if (!envRoot.present) {
          warnings.push(`\u6A21\u677F\u5F15\u7528\u7684\u73AF\u5883\u53D8\u91CF\u4E0D\u5B58\u5728\uFF1A{{ ${token.raw} }}`);
          continue;
        }
        rootValue = envRoot.value;
      } else {
        const nodeRoot = getNodeRoot(ctx, ref.nodeId ?? "");
        if (!nodeRoot.present) {
          warnings.push(`\u6A21\u677F\u5F15\u7528\u7684\u8282\u70B9\u4E0D\u5728\u4E0A\u4E0B\u6587\u4E2D\uFF1A{{ ${token.raw} }}`);
          continue;
        }
        rootValue = nodeRoot.value;
      }
      const resolved = resolvePath(rootValue, ref.path);
      if (!resolved.found) {
        warnings.push(`\u6A21\u677F\u5F15\u7528\u8DEF\u5F84\u4E0D\u5B58\u5728\uFF1A{{ ${token.raw} }}`);
        continue;
      }
      if (resolved.value === void 0 || resolved.value === null) {
        warnings.push(`\u6A21\u677F\u5F15\u7528\u7684\u503C\u4E3A null/undefined\uFF1A{{ ${token.raw} }}`);
        parts.push("");
        continue;
      }
      parts.push(stringifyValue(resolved.value));
    }
    return { value: parts.join(""), warnings };
  }
  function renderValueDeep(value, ctx) {
    const warnings = [];
    const walk = (current) => {
      if (typeof current === "string") {
        const rendered = renderTemplate(current, ctx);
        warnings.push(...rendered.warnings);
        return rendered.value;
      }
      if (Array.isArray(current)) {
        return current.map(walk);
      }
      if (current !== null && typeof current === "object") {
        const rendered = {};
        for (const [key, item] of Object.entries(current)) {
          rendered[key] = walk(item);
        }
        return rendered;
      }
      return current;
    };
    return { value: walk(value), warnings };
  }

  // flow-engine/src/csv.ts
  var VALID_DELIMITERS = [",", ";", "	"];
  function resolveCsvDelimiter(raw) {
    return VALID_DELIMITERS.includes(raw) && typeof raw === "string" ? raw : ",";
  }
  function splitCells(text, delimiter) {
    const rows = [];
    let row = [];
    let cell = "";
    let inQuotes = false;
    const textLength = text.length;
    const pushCell = () => {
      row.push(cell);
      cell = "";
    };
    const pushRow = () => {
      if (row.length === 1 && row[0] === "") {
        row = [];
        return;
      }
      rows.push(row);
      row = [];
    };
    for (let index = 0; index < textLength; index++) {
      const char = text[index];
      if (inQuotes) {
        if (char === '"') {
          if (text[index + 1] === '"') {
            cell += '"';
            index++;
          } else {
            inQuotes = false;
          }
        } else {
          cell += char;
        }
        continue;
      }
      if (char === '"' && cell === "") {
        inQuotes = true;
        continue;
      }
      if (char === delimiter) {
        pushCell();
        continue;
      }
      if (char === "\n") {
        pushCell();
        pushRow();
        continue;
      }
      if (char === "\r") {
        if (text[index + 1] === "\n") index++;
        pushCell();
        pushRow();
        continue;
      }
      cell += char;
    }
    if (cell !== "" || row.length > 0) {
      pushCell();
      pushRow();
    }
    return rows;
  }
  function parseCsv(text, delimiter) {
    const matrix = splitCells(text, delimiter);
    if (matrix.length === 0) return [];
    const header = matrix[0];
    const rows = [];
    for (let index = 1; index < matrix.length; index++) {
      const cells = matrix[index];
      const row = {};
      for (let column = 0; column < header.length; column++) {
        row[header[column]] = cells[column] ?? "";
      }
      rows.push(row);
    }
    return rows;
  }

  // flow-engine/src/utf8.ts
  var NATIVE_ENCODER = typeof globalThis.TextEncoder === "function" ? new globalThis.TextEncoder() : void 0;
  var NATIVE_DECODER = typeof globalThis.TextDecoder === "function" ? new globalThis.TextDecoder() : void 0;
  function utf8ByteLength(text) {
    if (NATIVE_ENCODER !== void 0) return NATIVE_ENCODER.encode(text).length;
    let bytes = 0;
    for (const char of text) {
      const code = char.codePointAt(0);
      if (code <= 127) bytes += 1;
      else if (code <= 2047) bytes += 2;
      else if (code >= 65536) bytes += 4;
      else bytes += 3;
    }
    return bytes;
  }
  function utf8Encode(text) {
    if (NATIVE_ENCODER !== void 0) return NATIVE_ENCODER.encode(text);
    const out = [];
    for (const char of text) {
      const code = char.codePointAt(0);
      if (code <= 127) {
        out.push(code);
      } else if (code <= 2047) {
        out.push(192 | code >> 6, 128 | code & 63);
      } else if (code >= 65536) {
        out.push(
          240 | code >> 18,
          128 | code >> 12 & 63,
          128 | code >> 6 & 63,
          128 | code & 63
        );
      } else if (code >= 55296 && code <= 57343) {
        out.push(239, 191, 189);
      } else {
        out.push(224 | code >> 12, 128 | code >> 6 & 63, 128 | code & 63);
      }
    }
    return Uint8Array.from(out);
  }
  function utf8Decode(bytes) {
    if (NATIVE_DECODER !== void 0) return NATIVE_DECODER.decode(bytes);
    let text = "";
    let index = 0;
    const total = bytes.length;
    while (index < total) {
      const byte = bytes[index];
      let code;
      let length;
      if (byte < 128) {
        code = byte;
        length = 1;
      } else if ((byte & 224) === 192 && index + 1 < total && (bytes[index + 1] & 192) === 128) {
        code = (byte & 31) << 6 | bytes[index + 1] & 63;
        length = 2;
      } else if ((byte & 240) === 224 && index + 2 < total && (bytes[index + 1] & 192) === 128 && (bytes[index + 2] & 192) === 128) {
        code = (byte & 15) << 12 | (bytes[index + 1] & 63) << 6 | bytes[index + 2] & 63;
        length = 3;
      } else if ((byte & 248) === 240 && index + 3 < total && (bytes[index + 1] & 192) === 128 && (bytes[index + 2] & 192) === 128 && (bytes[index + 3] & 192) === 128) {
        code = (byte & 7) << 18 | (bytes[index + 1] & 63) << 12 | (bytes[index + 2] & 63) << 6 | bytes[index + 3] & 63;
        length = 4;
      } else {
        code = 65533;
        length = 1;
      }
      if (code >= 65536) {
        const offset = code - 65536;
        text += String.fromCharCode(55296 + (offset >> 10), 56320 + (offset & 1023));
      } else {
        text += String.fromCharCode(code);
      }
      index += length;
    }
    return text;
  }
  function cutToUtf8Bytes(text, budget) {
    if (budget <= 0 || text.length === 0) return "";
    const bytes = utf8Encode(text);
    if (bytes.length <= budget) return text;
    let end = budget;
    while (end > 0 && (bytes[end] & 192) === 128) end--;
    return utf8Decode(bytes.subarray(0, end));
  }

  // flow-engine/src/run-record.ts
  var SNAPSHOT_MAX_BYTES = 256 * 1024;
  var RUN_RECORD_MAX_BYTES = 2 * 1024 * 1024;
  var DEGRADED_SNAPSHOT_BYTES = 64 * 1024;
  var MIN_DEGRADED_SNAPSHOT_BYTES = 128;
  var TRUNCATION_MARKER = "\u2026[ReqFlow \u5FEB\u7167\u5DF2\u622A\u65AD]";
  function isTruncatedSnapshot(value) {
    if (typeof value !== "object" || value === null) return false;
    const record = value;
    return record["__truncated"] === true && typeof record["preview"] === "string" && typeof record["originalBytes"] === "number";
  }
  var UTF8_ENCODER = { encode: utf8Encode };
  function safeSerialize(value) {
    try {
      return JSON.stringify(value) ?? "null";
    } catch {
      return '"<unserializable>"';
    }
  }
  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  var TRUNCATED_TAIL_PATTERN = new RegExp(
    `${escapeRegExp(TRUNCATION_MARKER)}\uFF08(?:([^\uFF09]*)\uFF0C)?\u539F (\\d+) \u5B57\u8282\uFF09$`
  );
  function parseTruncatedString(value) {
    const match = TRUNCATED_TAIL_PATTERN.exec(value);
    if (!match) return void 0;
    return { head: value.slice(0, match.index), originalBytes: Number(match[2]) };
  }
  function stringTruncationTail(originalBytes, label) {
    return label.length > 0 ? `${TRUNCATION_MARKER}\uFF08${label}\uFF0C\u539F ${originalBytes} \u5B57\u8282\uFF09` : `${TRUNCATION_MARKER}\uFF08\u539F ${originalBytes} \u5B57\u8282\uFF09`;
  }
  function previewTruncationTail(label) {
    return label.length > 0 ? `${TRUNCATION_MARKER}\uFF08${label}\uFF09` : TRUNCATION_MARKER;
  }
  function buildTruncatedWrapper(serialized, originalBytes, label, maxBytes) {
    const tail = previewTruncationTail(label);
    const skeleton = JSON.stringify({ __truncated: true, preview: "", originalBytes }) ?? "null";
    let budget = Math.max(0, maxBytes - utf8ByteLength(skeleton) - utf8ByteLength(tail) - 8);
    for (; ; ) {
      const wrapper = {
        __truncated: true,
        preview: cutToUtf8Bytes(serialized, budget) + tail,
        originalBytes
      };
      const actual = utf8ByteLength(JSON.stringify(wrapper));
      if (actual <= maxBytes || budget === 0) return wrapper;
      budget = Math.max(0, budget - Math.max(1, Math.ceil((actual - maxBytes) / 2)));
    }
  }
  function capSnapshot(value, maxBytes, label) {
    const limit = Math.max(0, maxBytes);
    if (isTruncatedSnapshot(value)) {
      const current = utf8ByteLength(safeSerialize(value));
      if (current <= limit) return { value, capped: false };
      const wrapper = buildTruncatedWrapper(value.preview, value.originalBytes, label, limit);
      return { value: wrapper, capped: true, originalBytes: value.originalBytes };
    }
    if (typeof value === "string") return capString(value, limit, label);
    const serialized = safeSerialize(value);
    const bytes = utf8ByteLength(serialized);
    if (bytes <= limit) return { value, capped: false };
    return {
      value: buildTruncatedWrapper(serialized, bytes, label, limit),
      capped: true,
      originalBytes: bytes
    };
  }
  function capString(value, maxBytes, label) {
    const bytes = utf8ByteLength(value);
    if (bytes <= maxBytes) return { value, capped: false };
    const previous = parseTruncatedString(value);
    const originalBytes = previous ? previous.originalBytes : bytes;
    let tail = stringTruncationTail(originalBytes, label);
    if (utf8ByteLength(tail) > maxBytes) {
      tail = utf8ByteLength(TRUNCATION_MARKER) <= maxBytes ? TRUNCATION_MARKER : "";
    }
    const head = cutToUtf8Bytes(previous ? previous.head : value, maxBytes - utf8ByteLength(tail));
    return { value: head + tail, capped: true, originalBytes };
  }
  function updateNodeRunSnapshot(nodeRuns, nodeId, nodeRun) {
    const merged = { ...nodeRuns };
    merged[nodeId] = nodeRun;
    return merged;
  }
  function capIterationsSummary(summary, maxBytes, nodeId) {
    const records = summary.records.map((record) => {
      const item = capSnapshot(record.item, maxBytes, `${nodeId}.iteration[${record.index}].item`);
      const output = capSnapshot(
        record.output,
        maxBytes,
        `${nodeId}.iteration[${record.index}].output`
      );
      return { ...record, item: item.value, output: output.value };
    });
    return { ...summary, records };
  }
  function capNodeRuns(nodeRuns, maxBytes) {
    const capped = {};
    for (const nodeId of Object.keys(nodeRuns)) {
      const run = nodeRuns[nodeId];
      const input = capSnapshot(run.input, maxBytes, `${nodeId}.input`);
      const output = capSnapshot(run.output, maxBytes, `${nodeId}.output`);
      const record = { ...run, input: input.value, output: output.value };
      if (run.iterations !== void 0) {
        record.iterations = capIterationsSummary(run.iterations, maxBytes, nodeId);
      }
      capped[nodeId] = record;
    }
    return capped;
  }
  function assembleRunRecord(input, nodeRuns) {
    const { summary } = input;
    const record = {
      id: input.runId,
      workflowId: input.workflowId ?? summary.workflowId,
      status: summary.status,
      trigger: input.trigger ?? "manual",
      startedAt: input.startedAt,
      nodeRuns
    };
    if (input.finishedAt !== void 0) record.finishedAt = input.finishedAt;
    if (summary.error !== void 0) record.error = summary.error;
    return record;
  }
  function serializedRecordBytes(record) {
    try {
      return UTF8_ENCODER.encode(JSON.stringify(record)).length;
    } catch {
      return 0;
    }
  }
  function buildRunRecord(input, options = {}) {
    const snapshotMaxBytes = Math.max(0, options.snapshotMaxBytes ?? SNAPSHOT_MAX_BYTES);
    const recordMaxBytes = options.recordMaxBytes ?? RUN_RECORD_MAX_BYTES;
    const rawNodeRuns = input.summary.nodeRuns;
    let nodeRuns = capNodeRuns(rawNodeRuns, snapshotMaxBytes);
    let record = assembleRunRecord(input, nodeRuns);
    if (serializedRecordBytes(record) <= recordMaxBytes) return record;
    let limit = Math.max(
      MIN_DEGRADED_SNAPSHOT_BYTES,
      options.degradedSnapshotBytes ?? DEGRADED_SNAPSHOT_BYTES
    );
    for (; ; ) {
      nodeRuns = capNodeRuns(rawNodeRuns, limit);
      record = assembleRunRecord(input, nodeRuns);
      if (serializedRecordBytes(record) <= recordMaxBytes) return record;
      if (limit <= MIN_DEGRADED_SNAPSHOT_BYTES) return record;
      limit = Math.max(MIN_DEGRADED_SNAPSHOT_BYTES, Math.floor(limit / 2));
    }
  }

  // flow-engine/src/logic-nodes.ts
  var DEFAULT_LOOP_MAX_ITERATIONS = 100;
  var LOOP_HARD_MAX_ITERATIONS = 1e3;
  var LOOP_MAX_CONCURRENCY = 16;
  var MAX_DELAY_DURATION_MS = 3e5;
  var LOOP_VARIABLE_NAME = "loop";
  var LOOP_ENTRY_ID_SUFFIX = "::loop-entry";
  var LOOP_ITERATION_SNAPSHOT_BYTES = 4 * 1024;
  var LOOP_ITERATIONS_MAX_RECORDS = 100;
  var DEFAULT_CONDITION_TIMEOUT_MS = DEFAULT_SCRIPT_TIMEOUT_MS;
  function isConditionBranchOutput(output) {
    if (typeof output !== "object" || output === null) return false;
    const branch = output.branch;
    return branch === "true" || branch === "false";
  }
  var CONDITION_DEADLINE_EXCEEDED = Object.freeze({ __reqflowConditionDeadline: true });
  function runConditionExpression(source, context, timeoutMs = DEFAULT_CONDITION_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    const checkDeadline = () => {
      if (Date.now() > deadline) throw CONDITION_DEADLINE_EXCEEDED;
    };
    const envParam = createEnvScriptParam(context.env);
    const safeInput = sanitizeJson(context.input);
    if (!safeInput.ok) {
      return {
        ok: false,
        error: {
          kind: "runtime",
          message: `\u6761\u4EF6\u8868\u8FBE\u5F0F\u5165\u53C2\uFF08input\uFF09\u4E0D\u662F\u53EF\u5B89\u5168\u4F20\u9012\u7684 JSON \u6570\u636E\uFF1A${safeInput.reason}`
        }
      };
    }
    const safeVars = sanitizeJson(context.vars);
    if (!safeVars.ok) {
      return {
        ok: false,
        error: {
          kind: "runtime",
          message: `\u6761\u4EF6\u8868\u8FBE\u5F0F\u5165\u53C2\uFF08vars\uFF09\u4E0D\u662F\u53EF\u5B89\u5168\u4F20\u9012\u7684 JSON \u6570\u636E\uFF1A${safeVars.reason}`
        }
      };
    }
    let factory;
    try {
      factory = new Function(
        SANDBOX_DEADLINE_PARAM,
        SANDBOX_CHECK_PARAM,
        "input",
        "vars",
        SCRIPT_ENV_PARAM_NAME,
        `"use strict";
${source}`
      );
    } catch (error) {
      return {
        ok: false,
        error: {
          kind: "syntax",
          message: `\u6761\u4EF6\u8868\u8FBE\u5F0F\u8BED\u6CD5\u9519\u8BEF\uFF1A${toErrorMessage3(error)}`,
          cause: error
        }
      };
    }
    const startedAt = Date.now();
    let value;
    try {
      value = factory(deadline, checkDeadline, safeInput.value, safeVars.value, envParam.value);
    } catch (error) {
      const envWrites2 = envParam.takeWrites();
      if (error === CONDITION_DEADLINE_EXCEEDED) {
        return {
          ok: false,
          error: {
            kind: "timeout",
            message: `\u6761\u4EF6\u8868\u8FBE\u5F0F\u901A\u8FC7 ${SANDBOX_CHECK_PARAM}() \u4E3B\u52A8\u4E2D\u65AD\uFF1A\u5DF2\u8D85\u8FC7\u622A\u6B62\u65F6\u95F4\uFF08\u4E0A\u9650 ${timeoutMs}ms\uFF09\u3002`
          },
          ...envWrites2 !== void 0 ? { envWrites: envWrites2 } : {}
        };
      }
      return {
        ok: false,
        error: {
          kind: "runtime",
          message: `\u6761\u4EF6\u8868\u8FBE\u5F0F\u8FD0\u884C\u65F6\u9519\u8BEF\uFF1A${toErrorMessage3(error)}`,
          cause: error
        },
        ...envWrites2 !== void 0 ? { envWrites: envWrites2 } : {}
      };
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed > timeoutMs) {
      const envWrites2 = envParam.takeWrites();
      return {
        ok: false,
        error: {
          kind: "timeout",
          message: `\u6761\u4EF6\u8868\u8FBE\u5F0F\u6267\u884C\u8F6F\u8D85\u65F6\uFF1A\u5B9E\u9645\u8017\u65F6 ${elapsed}ms \u8D85\u8FC7\u4E0A\u9650 ${timeoutMs}ms\u3002`
        },
        ...envWrites2 !== void 0 ? { envWrites: envWrites2 } : {}
      };
    }
    const safeReturn = sanitizeJson(value);
    const envWrites = envParam.takeWrites();
    if (!safeReturn.ok) {
      return {
        ok: false,
        error: {
          kind: "invalid-return",
          message: `\u6761\u4EF6\u8868\u8FBE\u5F0F\u8FD4\u56DE\u503C\u4E0D\u662F\u5408\u6CD5 JSON\uFF1A${safeReturn.reason}`
        },
        ...envWrites !== void 0 ? { envWrites } : {}
      };
    }
    return {
      ok: true,
      value: safeReturn.value,
      ...envWrites !== void 0 ? { envWrites } : {}
    };
  }
  var defaultConditionPort = {
    runCondition: async (source, context, timeoutMs) => runConditionExpression(source, context, timeoutMs)
  };
  function createConditionRunner(deps) {
    const runCondition = deps?.scriptPort ?? defaultConditionPort;
    return async (node, input, runCtx) => {
      const source = typeof node.config.expression === "string" ? node.config.expression : "";
      const vars = runCtx.nodeCtx.templateContext.var ?? {};
      const env = runCtx.nodeCtx.templateContext.env;
      const result = await runCondition.runCondition(
        source,
        { input, vars, ...env !== void 0 ? { env } : {} },
        deps?.timeoutMs
      );
      if (result.envWrites !== void 0) deps?.onEnvWrite?.(result.envWrites);
      if (!result.ok) throw new ScriptExecutionError(result.error);
      return {
        branch: Boolean(result.value) ? "true" : "false",
        value: result.value
      };
    };
  }
  function abortableDelay(durationMs, signal) {
    if (durationMs <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cancelledError = () => new Error("[cancelled] \u5EF6\u65F6\u7B49\u5F85\u88AB\u53D6\u6D88");
      if (signal?.aborted) {
        reject(cancelledError());
        return;
      }
      const timer = hostSetTimeout(() => {
        cleanup();
        resolve();
      }, durationMs);
      const onAbort = () => {
        cleanup();
        reject(cancelledError());
      };
      const cleanup = () => {
        hostClearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  function createDelayRunner() {
    return async (node, input, runCtx) => {
      const raw = node.config.durationMs;
      const duration = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
      if (duration > MAX_DELAY_DURATION_MS) {
        throw new Error(
          `\u5EF6\u65F6\u65F6\u957F\u8D85\u51FA\u4E0A\u9650\uFF1A${duration}ms > ${MAX_DELAY_DURATION_MS}ms\uFF085 \u5206\u949F\uFF09\uFF0C\u8BF7\u62C6\u5206\u591A\u4E2A\u5EF6\u65F6\u8282\u70B9`
        );
      }
      await abortableDelay(duration, runCtx.signal);
      return input;
    };
  }
  function resolveAssignmentValue(assignment, context) {
    if (assignment === null || typeof assignment !== "object") {
      throw new Error("\u8D4B\u503C\u9879\u5F62\u72B6\u975E\u6CD5\uFF08\u9700\u4E3A\u5BF9\u8C61\uFF09");
    }
    const record = assignment;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (name === "") throw new Error("\u8D4B\u503C\u9879\u7684\u53D8\u91CF\u540D\u4E0D\u80FD\u4E3A\u7A7A");
    let value;
    if (record.from === "literal") {
      const raw = record.value;
      value = typeof raw === "string" ? renderTemplate(raw, context.templateContext).value : raw;
    } else {
      const path = typeof record.path === "string" ? record.path : "";
      let root;
      let rootLabel;
      if (record.from === "input") {
        root = context.input;
        rootLabel = "input";
      } else if (record.from === "node") {
        const nodeId = record.node;
        if (typeof nodeId !== "string" || nodeId === "") {
          throw new Error(`\u8D4B\u503C\u9879\u300C${name}\u300D\u672A\u6307\u5B9A\u6765\u6E90\u8282\u70B9\uFF08from: 'node' \u9700\u63D0\u4F9B node \u5B57\u6BB5\uFF09`);
        }
        const nodeKey = context.refKeyOf !== void 0 ? context.refKeyOf(nodeId) : nodeId;
        if (!Object.prototype.hasOwnProperty.call(context.nodeOutputs, nodeKey)) {
          throw new Error(`\u8D4B\u503C\u9879\u300C${name}\u300D\u5F15\u7528\u7684\u8282\u70B9\u4E0D\u5728\u4E0A\u4E0B\u6587\u4E2D\uFF1A${nodeId}\uFF08\u5C1A\u672A\u6267\u884C\u6216\u975E\u4E0A\u6E38\uFF09`);
        }
        root = context.nodeOutputs[nodeKey];
        rootLabel = `\u8282\u70B9 ${nodeId} \u7684\u8F93\u51FA`;
      } else if (record.from === "var") {
        root = context.vars;
        rootLabel = "\u53D8\u91CF\u8868";
      } else {
        throw new Error(
          `\u8D4B\u503C\u9879\u300C${name}\u300D\u7684\u6765\u6E90\u975E\u6CD5\uFF1A${String(record.from)}\uFF08\u53EA\u5141\u8BB8 input / node / var / literal\uFF09`
        );
      }
      const resolved = resolvePath(root, path);
      if (!resolved.found) {
        throw new Error(`\u8D4B\u503C\u9879\u300C${name}\u300D\u7684\u53D6\u503C\u8DEF\u5F84\u4E0D\u5B58\u5728\uFF1A${rootLabel} \u4E0A\u7684 "${path}"`);
      }
      value = resolved.value;
    }
    return { name, value };
  }
  function createSetVariableRunner(deps) {
    return async (node, input, runCtx) => {
      const store = runCtx.iterationStore ?? deps.getStore();
      if (!store) {
        throw new Error("\u53D8\u91CF\u5B58\u50A8\u4E0D\u53EF\u7528\uFF08\u672C\u6B21\u8FD0\u884C\u672A\u88C5\u914D RunVariableStore\uFF09\uFF0C\u65E0\u6CD5\u5199\u5165\u53D8\u91CF");
      }
      const assignments = Array.isArray(node.config.assignments) ? node.config.assignments : [];
      for (const assignment of assignments) {
        const currentVars = store.snapshot();
        const context = {
          input,
          nodeOutputs: runCtx.nodeCtx.nodeOutputs,
          vars: currentVars,
          templateContext: buildTemplateContext(runCtx.nodeCtx.nodeOutputs, input, currentVars),
          // M15-T2：赋值项 from='node' 手持内部 id，经执行器注入的换算定位输出表
          refKeyOf: runCtx.nodeCtx.refKeyOf
        };
        const { name, value } = resolveAssignmentValue(assignment, context);
        store.set(name, value);
      }
      return input;
    };
  }
  function emptyLoopBodyPlan() {
    return { bodyNodes: [], entryIds: [], bodyEdges: [], sinkIds: [] };
  }
  function computeLoopBody(loopId, nodes, edges) {
    const nodeById = /* @__PURE__ */ new Map();
    for (const node of nodes) nodeById.set(node.id, node);
    if (!nodeById.has(loopId)) return emptyLoopBodyPlan();
    const upstreams = /* @__PURE__ */ new Map();
    const downstreams = /* @__PURE__ */ new Map();
    for (const edge of edges) {
      if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
      if (!upstreams.has(edge.target)) upstreams.set(edge.target, []);
      if (!upstreams.get(edge.target).includes(edge.source))
        upstreams.get(edge.target).push(edge.source);
      if (!downstreams.has(edge.source)) downstreams.set(edge.source, []);
      if (!downstreams.get(edge.source).includes(edge.target))
        downstreams.get(edge.source).push(edge.target);
    }
    const reachable = /* @__PURE__ */ new Set();
    const reachQueue = (downstreams.get(loopId) ?? []).filter((id) => id !== loopId);
    while (reachQueue.length > 0) {
      const id = reachQueue.shift();
      if (reachable.has(id) || id === loopId) continue;
      reachable.add(id);
      reachQueue.push(...downstreams.get(id) ?? []);
    }
    if (reachable.size === 0) return emptyLoopBodyPlan();
    const admissible = /* @__PURE__ */ new Set();
    for (const id of reachable) {
      const node = nodeById.get(id);
      if (node?.type === "stickyNote") continue;
      const ups = upstreams.get(id) ?? [];
      if (ups.every((up) => up === loopId || reachable.has(up))) admissible.add(id);
    }
    if (admissible.size === 0) return emptyLoopBodyPlan();
    const indegree = /* @__PURE__ */ new Map();
    for (const id of admissible) {
      const count = (upstreams.get(id) ?? []).filter(
        (up) => up !== loopId && admissible.has(up)
      ).length;
      indegree.set(id, count);
    }
    const admitted = /* @__PURE__ */ new Set();
    const queue = [...admissible].filter((id) => indegree.get(id) === 0);
    while (queue.length > 0) {
      const id = queue.shift();
      admitted.add(id);
      for (const next of downstreams.get(id) ?? []) {
        if (!admissible.has(next) || next === loopId || admitted.has(next)) continue;
        const nextDegree = (indegree.get(next) ?? 0) - 1;
        indegree.set(next, nextDegree);
        if (nextDegree === 0) queue.push(next);
      }
    }
    if (admitted.size === 0) return emptyLoopBodyPlan();
    const directTargets = /* @__PURE__ */ new Set();
    for (const edge of edges) {
      if (edge.source === loopId && edge.target !== loopId && admitted.has(edge.target)) {
        directTargets.add(edge.target);
      }
    }
    const entryIds = [];
    for (const id of directTargets) {
      const bodyUpstreams = (upstreams.get(id) ?? []).filter(
        (up) => up !== loopId && admitted.has(up)
      );
      if (bodyUpstreams.length === 0) entryIds.push(id);
    }
    const bodyEdges = edges.filter((edge) => admitted.has(edge.source) && admitted.has(edge.target));
    const sinkIds = [];
    for (const id of admitted) {
      const exits = (downstreams.get(id) ?? []).some((next) => admitted.has(next));
      if (!exits) sinkIds.push(id);
    }
    const bodyNodes = nodes.filter((node) => admitted.has(node.id));
    return { bodyNodes, entryIds, bodyEdges, sinkIds };
  }
  function buildBodyWorkflow(loopId, plan) {
    const entryId = asNodeId(`${loopId}${LOOP_ENTRY_ID_SUFFIX}`);
    const virtualStart = {
      id: entryId,
      type: "start",
      position: { x: 0, y: 0 },
      config: {}
    };
    const edges = plan.entryIds.map((target) => ({
      id: asEdgeId(`${entryId}->${target}`),
      source: entryId,
      target
    }));
    edges.push(...plan.bodyEdges);
    return {
      id: asWorkflowId(`${loopId}${LOOP_ENTRY_ID_SUFFIX}`),
      entryId,
      nodes: [virtualStart, ...plan.bodyNodes],
      edges
    };
  }
  function resolveLoopItems(config, ctx) {
    if (typeof config.csvText === "string" && config.csvText !== "") {
      return parseCsv(
        renderTemplate(config.csvText, ctx).value,
        resolveCsvDelimiter(config.csvDelimiter)
      );
    }
    const raw = config.items;
    if (raw === void 0 || raw === null) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw !== "string") {
      throw new Error(
        "\u5FAA\u73AF items \u914D\u7F6E\u975E\u6CD5\uFF1A\u9700\u4E3A JSON \u6570\u7EC4\u5B57\u9762\u91CF\u6216\u53EF\u6E32\u67D3\u89E3\u6790\u4E3A JSON \u6570\u7EC4\u7684\u6A21\u677F\u5B57\u7B26\u4E32"
      );
    }
    const rendered = renderTemplate(raw, ctx).value;
    if (rendered.trim() === "") return [];
    let parsed;
    try {
      parsed = JSON.parse(rendered);
    } catch (error) {
      throw new Error(
        `\u5FAA\u73AF items \u6E32\u67D3\u540E\u4E0D\u662F\u5408\u6CD5 JSON\uFF1A${toErrorMessage3(error)}\uFF08\u6E32\u67D3\u7ED3\u679C\uFF1A${truncate(rendered, 80)}\uFF09`
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`\u5FAA\u73AF items \u6E32\u67D3\u540E\u4E0D\u662F JSON \u6570\u7EC4\uFF08\u5F97\u5230 ${typeof parsed}\uFF09`);
    }
    return parsed;
  }
  function resolveLoopMaxIterations(config) {
    const raw = config.maxIterations;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
      return DEFAULT_LOOP_MAX_ITERATIONS;
    }
    return Math.min(Math.floor(raw), LOOP_HARD_MAX_ITERATIONS);
  }
  function resolveLoopExecutionOptions(config, opts) {
    const intervalMs = config.intervalMs;
    const normalizedInterval = typeof intervalMs === "number" && Number.isFinite(intervalMs) && intervalMs > 0 ? Math.min(6e4, Math.floor(intervalMs)) : 0;
    if (opts?.isolatedVariableScope !== true) {
      return { concurrency: 1, intervalMs: normalizedInterval };
    }
    const raw = config.concurrency;
    const concurrency = typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? Math.min(LOOP_MAX_CONCURRENCY, raw) : 1;
    return { concurrency, intervalMs: normalizedInterval };
  }
  function truncate(text, max) {
    return text.length <= max ? text : `${text.slice(0, max)}\u2026`;
  }
  function collectIterationResult(summary, plan) {
    const outputs = [];
    for (const sinkId of plan.sinkIds) {
      const record = summary.nodeRuns[sinkId];
      if (record && record.status === "success") outputs.push([sinkId, record.output]);
    }
    if (outputs.length === 0) return null;
    if (outputs.length === 1) return outputs[0][1];
    const grouped = {};
    for (const [id, output] of outputs) grouped[id] = output;
    return grouped;
  }
  function asOverlayCapableStore(store) {
    if (store === void 0 || typeof store !== "object") return void 0;
    const candidate = store;
    const methods = [
      candidate.get,
      candidate.has,
      candidate.set,
      candidate.snapshot,
      candidate.createOverlay
    ];
    return methods.every((method) => typeof method === "function") ? store : void 0;
  }
  function injectIterationStore(runners, scope) {
    const injected = {};
    for (const [type, runner] of Object.entries(runners)) {
      if (!runner) continue;
      injected[type] = async (node, input, runCtx) => runner(node, input, Object.assign({}, runCtx, { iterationStore: scope }));
    }
    return injected;
  }
  function createLoopRunner(deps) {
    return async (node, _input, runCtx) => {
      const items = resolveLoopItems(node.config, runCtx.nodeCtx.templateContext);
      const maxIterations = resolveLoopMaxIterations(node.config);
      const plan = deps.getBodyPlan?.(node.id);
      const results = [];
      if (!plan || plan.bodyNodes.length === 0 || plan.entryIds.length === 0) {
        return results;
      }
      const subWorkflow = buildBodyWorkflow(node.id, plan);
      const entryId = subWorkflow.entryId;
      const store = deps.getStore?.();
      const inheritedScope = runCtx.iterationStore;
      const isolationBase = inheritedScope ?? asOverlayCapableStore(store);
      const count = Math.min(items.length, maxIterations);
      const { concurrency, intervalMs } = resolveLoopExecutionOptions(node.config, {
        isolatedVariableScope: isolationBase !== void 0
      });
      const mergeExcludes = inheritedScope !== void 0 ? [LOOP_VARIABLE_NAME] : void 0;
      const iterationRecords = [];
      let settledCount = 0;
      const iterationCapped = items.length > maxIterations;
      const reportProgress = () => {
        deps.reportLoopProgress?.(node, {
          done: settledCount,
          total: count,
          capped: iterationCapped
        });
      };
      const capIterationValue = (value, index, kind) => capSnapshot(value, LOOP_ITERATION_SNAPSHOT_BYTES, `${node.id}.iteration[${index}].${kind}`).value;
      const pushIterationRecord = (index, item, startedAt, status, output, error) => {
        settledCount += 1;
        iterationRecords.push({
          index,
          item: capIterationValue(item, index, "item"),
          status,
          output,
          startedAt,
          durationMs: Date.now() - startedAt,
          ...error !== void 0 ? { error } : {}
        });
        reportProgress();
      };
      const runIteration = async (index) => {
        if (runCtx.signal?.aborted) return null;
        const item = items[index];
        const iterationStartedAt = Date.now();
        const scope = isolationBase !== void 0 ? isolationBase.createOverlay() : void 0;
        const hadLoopVar = scope === void 0 && store !== void 0 && store.has(LOOP_VARIABLE_NAME);
        const previousLoopVar = hadLoopVar && store ? store.get(LOOP_VARIABLE_NAME) : void 0;
        const effectiveStore = scope ?? store;
        effectiveStore?.set(LOOP_VARIABLE_NAME, { item, index });
        try {
          const summary = await executeWorkflow(subWorkflow, {
            runners: scope !== void 0 ? injectIterationStore(deps.getRunners?.() ?? {}, scope) : deps.getRunners?.() ?? {},
            signal: runCtx.signal,
            ...effectiveStore !== void 0 ? { variables: () => effectiveStore.snapshot() } : {},
            // 环境快照供给（M14-T2）：循环体与主链路同源（供给函数形态，写回可见）
            ...deps.getEnv ? { env: deps.getEnv } : {},
            selectDownstream: createWorkflowDownstreamSelector(subWorkflow.nodes, subWorkflow.edges),
            ...deps.forwardNodeStart ? {
              onNodeStart: (bodyNode, bodyInput) => {
                if (bodyNode.id !== entryId) deps.forwardNodeStart?.(bodyNode, bodyInput);
              }
            } : {},
            ...deps.forwardNodeFinish ? {
              onNodeFinish: (bodyNode, nodeRun) => {
                if (bodyNode.id !== entryId) deps.forwardNodeFinish?.(bodyNode, nodeRun);
              }
            } : {}
          });
          if (summary.status === "cancelled") {
            pushIterationRecord(index, item, iterationStartedAt, "cancelled", null);
            return void 0;
          }
          if (summary.status === "failed") {
            const message = `\u7B2C ${index + 1} \u8F6E\u5FAA\u73AF\u4F53\u6267\u884C\u5931\u8D25\uFF1A${summary.error ?? "\u672A\u77E5\u9519\u8BEF"}`;
            pushIterationRecord(index, item, iterationStartedAt, "failed", null, message);
            throw new Error(message);
          }
          if (deps.collectNestedRun) {
            for (const [bodyNodeId, nodeRun] of Object.entries(summary.nodeRuns)) {
              if (bodyNodeId !== entryId) deps.collectNestedRun(asNodeId(bodyNodeId), nodeRun);
            }
          }
          const collected = collectIterationResult(summary, plan);
          pushIterationRecord(
            index,
            item,
            iterationStartedAt,
            "success",
            capIterationValue(collected, index, "output")
          );
          return collected;
        } finally {
          if (scope !== void 0) {
            scope.mergeBack(mergeExcludes);
          } else if (store && hadLoopVar) {
            store.set(LOOP_VARIABLE_NAME, previousLoopVar);
          }
        }
      };
      if (count > 0 && !runCtx.signal?.aborted) reportProgress();
      try {
        for (let start = 0; start < count; start += concurrency) {
          if (runCtx.signal?.aborted) break;
          if (start > 0 && intervalMs > 0) await abortableDelay(intervalMs, runCtx.signal);
          const indexes = Array.from(
            { length: Math.min(concurrency, count - start) },
            (_, offset) => start + offset
          );
          const batchResults = await Promise.all(indexes.map((index) => runIteration(index)));
          results.push(...batchResults.filter((value) => value !== void 0));
        }
      } finally {
        const orderedRecords = [...iterationRecords].sort((a, b) => a.index - b.index);
        const recordsTruncated = orderedRecords.length > LOOP_ITERATIONS_MAX_RECORDS;
        runCtx.snapshotExtras = {
          iterations: {
            total: count,
            done: settledCount,
            capped: iterationCapped,
            records: recordsTruncated ? orderedRecords.slice(0, LOOP_ITERATIONS_MAX_RECORDS) : orderedRecords,
            truncated: recordsTruncated
          }
        };
      }
      return results;
    };
  }
  function createWorkflowDownstreamSelector(nodes, edges) {
    const bodyPlanCache = /* @__PURE__ */ new Map();
    const getBodyPlan = (loopId) => {
      let plan = bodyPlanCache.get(loopId);
      if (plan === void 0) {
        plan = computeLoopBody(loopId, nodes, edges);
        bodyPlanCache.set(loopId, plan);
      }
      return plan;
    };
    const hasHandledOutgoing = (nodeId) => edges.some(
      (edge) => edge.source === nodeId && (edge.sourceHandle === "true" || edge.sourceHandle === "false")
    );
    return (node, output) => {
      if (node.type === "loop") {
        const plan = getBodyPlan(node.id);
        if (plan.bodyNodes.length === 0) return "all";
        const entries = new Set(plan.entryIds);
        const targets = [];
        for (const edge of edges) {
          if (edge.source !== node.id) continue;
          if (entries.has(edge.target)) continue;
          if (!targets.includes(edge.target)) targets.push(edge.target);
        }
        return targets;
      }
      if (node.type === "condition") {
        if (!isConditionBranchOutput(output)) return "all";
        if (hasHandledOutgoing(node.id)) {
          const active2 = [];
          for (const edge of edges) {
            if (edge.source !== node.id) continue;
            const handle = edge.sourceHandle;
            if (handle === "true" || handle === "false") {
              if (handle !== output.branch) continue;
            }
            if (!active2.includes(edge.target)) active2.push(edge.target);
          }
          return active2;
        }
        const { trueTargets, falseTargets } = node.config;
        const trueList = Array.isArray(trueTargets) ? trueTargets : [];
        const falseList = Array.isArray(falseTargets) ? falseTargets : [];
        if (trueList.length === 0 && falseList.length === 0) return "all";
        const branchList = output.branch === "true" ? trueList : falseList;
        const selected = new Set(branchList);
        const active = [...selected];
        for (const edge of edges) {
          if (edge.source !== node.id) continue;
          if (selected.has(edge.target)) continue;
          if (trueList.includes(edge.target) || falseList.includes(edge.target)) continue;
          if (!active.includes(edge.target)) active.push(edge.target);
        }
        return active;
      }
      return "all";
    };
  }
  function toErrorMessage3(error) {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  // flow-engine/src/script-port.ts
  function createLocalScriptPort() {
    return {
      runPre: async (source, input, opts) => runPreScript(source, input, opts),
      runPost: async (source, response, opts) => runPostScript(source, response, opts),
      runCondition: async (source, context, timeoutMs) => runConditionExpression(source, context, timeoutMs)
    };
  }

  // flow-engine/src/base64.ts
  var BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var BASE64_LOOKUP = {};
  for (let index = 0; index < BASE64_ALPHABET.length; index++) {
    BASE64_LOOKUP[BASE64_ALPHABET[index]] = index;
  }
  function decodeBase64(text) {
    let body = "";
    let padding = 0;
    for (const char of text) {
      if (char === "=") {
        padding += 1;
        continue;
      }
      if (char === " " || char === "\n" || char === "\r" || char === "	") continue;
      if (padding > 0) throw new Error("InvalidCharacterError: base64 \u586B\u5145\u7B26\u540E\u5B58\u5728\u6570\u636E\u5B57\u7B26");
      if (BASE64_LOOKUP[char] === void 0) {
        throw new Error(`InvalidCharacterError: \u975E\u6CD5 base64 \u5B57\u7B26\u300C${char}\u300D`);
      }
      body += char;
    }
    if (padding > 2) throw new Error("InvalidCharacterError: base64 \u586B\u5145\u7B26\u8FC7\u591A");
    const remainder = body.length % 4;
    if (remainder === 1) throw new Error("InvalidCharacterError: base64 \u957F\u5EA6\u975E\u6CD5\uFF08\u4F59 1 \u5B57\u7B26\uFF09");
    const normalized = body + (remainder === 2 ? "AA" : remainder === 3 ? "A" : "");
    const bytes = [];
    for (let index = 0; index < normalized.length; index += 4) {
      const n = BASE64_LOOKUP[normalized[index]] << 18 | BASE64_LOOKUP[normalized[index + 1]] << 12 | BASE64_LOOKUP[normalized[index + 2]] << 6 | BASE64_LOOKUP[normalized[index + 3]];
      if (remainder !== 0 && index + 4 === normalized.length) {
        if (remainder === 2) bytes.push(n >> 16 & 255);
        else {
          bytes.push(n >> 16 & 255, n >> 8 & 255);
        }
        break;
      }
      bytes.push(n >> 16 & 255, n >> 8 & 255, n & 255);
    }
    return Uint8Array.from(bytes);
  }
  function encodeBase64(bytes) {
    let out = "";
    const total = bytes.length;
    for (let index = 0; index < total; index += 3) {
      const b0 = bytes[index];
      const b1 = index + 1 < total ? bytes[index + 1] : 0;
      const b2 = index + 2 < total ? bytes[index + 2] : 0;
      const triple = b0 << 16 | b1 << 8 | b2;
      out += BASE64_ALPHABET[triple >> 18 & 63];
      out += BASE64_ALPHABET[triple >> 12 & 63];
      out += index + 1 < total ? BASE64_ALPHABET[triple >> 6 & 63] : "=";
      out += index + 2 < total ? BASE64_ALPHABET[triple & 63] : "=";
    }
    return out;
  }

  // flow-engine/src/replay.ts
  var HEADERS_POLICY = {
    /** 一律剥离的请求头名（小写精确匹配） */
    STRIP_EXACT: ["content-length", "host", "origin", "cookie"],
    /** 一律剥离的请求头名前缀（小写前缀匹配）：sec-fetch-site/mode/... 与 sec-ch-ua 系 */
    STRIP_PREFIXES: ["sec-fetch-", "sec-ch-ua"],
    /** referer 头名：默认剥离，stripBrowserOnlyHeaders 的 keepReferer 可保留 */
    REFERER: "referer",
    /** user-agent 头名：默认透传 HAR 原值（R3），keepUserAgent=false 可关 */
    USER_AGENT: "user-agent"
  };
  var KEEP_UA = true;
  var KEEP_REFERER = false;
  function stripBrowserOnlyHeaders(headers, opts) {
    const keepUserAgent = opts?.keepUserAgent ?? KEEP_UA;
    const keepReferer = opts?.keepReferer ?? KEEP_REFERER;
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      if (HEADERS_POLICY.STRIP_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
      if (HEADERS_POLICY.STRIP_EXACT.includes(lower)) continue;
      if (lower === HEADERS_POLICY.REFERER && !keepReferer) continue;
      if (lower === HEADERS_POLICY.USER_AGENT && !keepUserAgent) continue;
      out[name] = value;
    }
    return out;
  }
  function decodeBaselinePostData(postData) {
    if (!postData || postData.text === void 0) return void 0;
    if (postData.encoding !== "base64") return postData.text;
    try {
      return decodeBase64(postData.text);
    } catch {
      return postData.text;
    }
  }
  function normalizeBodyOverride(value) {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  function applyReplayOverride(target, source) {
    if (!source) return;
    if (typeof source.method === "string" && source.method !== "") target.method = source.method;
    if (typeof source.url === "string" && source.url !== "") target.url = source.url;
    if (source.headers) {
      for (const [key, value] of Object.entries(source.headers)) {
        if (typeof value !== "string") continue;
        target.headers[key] = value;
      }
    }
    if (source.removedHeaders) {
      const removed = new Set(source.removedHeaders.map((name) => name.toLowerCase()));
      for (const name of Object.keys(target.headers)) {
        if (removed.has(name.toLowerCase())) delete target.headers[name];
      }
    }
    if (source.body !== void 0 && source.body !== null) {
      target.body = normalizeBodyOverride(source.body);
    }
    if (typeof source.timeoutMs === "number" && Number.isFinite(source.timeoutMs) && source.timeoutMs > 0) {
      target.timeoutMs = source.timeoutMs;
    }
  }
  function buildReplayRequest(params, templateContext) {
    const { harEntry, override, extraOverride } = params;
    const harRequest = harEntry.request;
    const headers = {};
    for (const header of harRequest.headers) {
      headers[header.name] = header.value;
    }
    const target = {
      method: harRequest.method,
      url: harRequest.url,
      headers,
      // 基线 body = postData.text（encoding='base64' 时解码为字节）；无 postData 为 undefined
      body: decodeBaselinePostData(harRequest.postData),
      timeoutMs: void 0
    };
    applyReplayOverride(target, override);
    applyReplayOverride(target, extraOverride);
    const strippedHeaders = stripBrowserOnlyHeaders(target.headers);
    let finalUrl = target.url;
    let finalHeaders = strippedHeaders;
    let finalBody = target.body;
    if (templateContext) {
      finalUrl = renderTemplate(finalUrl, templateContext).value;
      finalHeaders = renderValueDeep(strippedHeaders, templateContext).value;
      if (finalBody !== void 0 && typeof finalBody === "string") {
        finalBody = renderTemplate(finalBody, templateContext).value;
      }
    }
    const request = {
      method: target.method,
      url: finalUrl,
      headers: finalHeaders
    };
    if (finalBody !== void 0) request.body = finalBody;
    if (target.timeoutMs !== void 0) request.timeoutMs = target.timeoutMs;
    return request;
  }

  // flow-engine/src/cancel-signal.ts
  function createCancelSource() {
    let aborted = false;
    const listeners = /* @__PURE__ */ new Set();
    const signal = {
      get aborted() {
        return aborted;
      },
      addEventListener(_type, listener, options) {
        if (aborted) {
          listener();
          return;
        }
        listeners.add({ listener, once: options?.once });
      },
      removeEventListener(_type, listener) {
        for (const entry of listeners) {
          if (entry.listener === listener) {
            listeners.delete(entry);
            return;
          }
        }
      }
    };
    return {
      signal,
      cancel() {
        if (aborted) return;
        aborted = true;
        for (const entry of [...listeners]) {
          if (entry.once) listeners.delete(entry);
          entry.listener();
        }
        listeners.clear();
      }
    };
  }

  // flow-engine/src/json-equal.ts
  function jsonDeepEqual(a, b) {
    if (a === b) return true;
    if (typeof a === "number" && typeof b === "number") {
      return false;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((item, index) => jsonDeepEqual(item, b[index]));
    }
    if (isPlainObject(a) && isPlainObject(b)) {
      const aKeys = Object.keys(a);
      const bKeys = Object.keys(b);
      if (aKeys.length !== bKeys.length) return false;
      return aKeys.every(
        (key) => Object.prototype.hasOwnProperty.call(b, key) && jsonDeepEqual(a[key], b[key])
      );
    }
    return false;
  }
  function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  // flow-engine/src/json-path.ts
  function parseJsonPath(path) {
    const fail = (reason) => ({
      ok: false,
      error: `JSONPath \u8BED\u6CD5\u9519\u8BEF\uFF1A${reason}\uFF08\u8DEF\u5F84\uFF1A${path}\uFF09`
    });
    const text = typeof path === "string" ? path : "";
    if (!text.startsWith("$")) return fail('\u5FC5\u987B\u4EE5\u6839\u6807\u8BC6 "$" \u5F00\u5934');
    const segments = [];
    let i = 1;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "." && text[i + 1] === ".") {
        const name = readName(text, i + 2);
        if (name.length === 0) return fail('".." \u540E\u9700\u7D27\u8DDF\u5C5E\u6027\u540D\uFF08"..*" / "..[" \u4E0D\u652F\u6301\uFF09');
        segments.push({ type: "descendant", name });
        i += 2 + name.length;
        continue;
      }
      if (ch === ".") {
        if (text[i + 1] === "*") {
          segments.push({ type: "wildcard" });
          i += 2;
          continue;
        }
        const name = readName(text, i + 1);
        if (name.length === 0) return fail('"." \u540E\u9700\u7D27\u8DDF\u5C5E\u6027\u540D\uFF08\u5982 $.a.b\uFF09');
        segments.push({ type: "property", name });
        i += 1 + name.length;
        continue;
      }
      if (ch === "[") {
        const close = text.indexOf("]", i);
        if (close === -1) return fail('\u7F3A\u5C11\u95ED\u5408\u7684 "]"');
        const inner = text.slice(i + 1, close).trim();
        if (inner === "*") {
          segments.push({ type: "wildcard" });
        } else if (/^(0|[1-9]\d*)$/.test(inner)) {
          segments.push({ type: "index", index: Number.parseInt(inner, 10) });
        } else if (inner.startsWith("'") && inner.endsWith("'") && inner.length >= 2 || inner.startsWith('"') && inner.endsWith('"') && inner.length >= 2) {
          const name = inner.slice(1, -1);
          if (name.length === 0) return fail('\u5F15\u53F7\u5C5E\u6027\u540D\u4E0D\u80FD\u4E3A\u7A7A\uFF08\u5982 $.["a b"]\uFF09');
          segments.push({ type: "property", name });
        } else {
          return fail(`\u62EC\u53F7\u6BB5\u300C${inner}\u300D\u4E0D\u652F\u6301\uFF08\u53EA\u5141\u8BB8\u975E\u8D1F\u6574\u6570\u4E0B\u6807 / * / \u5F15\u53F7\u5C5E\u6027\u540D\uFF09`);
        }
        i = close + 1;
        continue;
      }
      return fail(`\u51FA\u73B0\u4E0D\u652F\u6301\u7684\u5B57\u7B26\u300C${ch}\u300D\uFF08\u6BB5\u4E4B\u95F4\u53EA\u5141\u8BB8 "." / "[" \u5F00\u5934\uFF09`);
    }
    return { ok: true, segments };
  }
  function readName(text, from) {
    let end = from;
    while (end < text.length && !" 	.[]*".includes(text[end])) end++;
    return text.slice(from, end);
  }
  function applySegment(current, segment) {
    switch (segment.type) {
      case "property": {
        if (current === null || typeof current !== "object") return [];
        const value = current[segment.name];
        return Object.prototype.hasOwnProperty.call(current, segment.name) ? [value] : [];
      }
      case "index": {
        if (!Array.isArray(current)) return [];
        return segment.index < current.length ? [current[segment.index]] : [];
      }
      case "wildcard": {
        if (Array.isArray(current)) return [...current];
        if (current !== null && typeof current === "object") return Object.values(current);
        return [];
      }
      case "descendant": {
        const hits = [];
        collectDescendant(current, segment.name, hits);
        return hits;
      }
    }
  }
  function collectDescendant(node, name, hits) {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) collectDescendant(item, name, hits);
      return;
    }
    const record = node;
    if (Object.prototype.hasOwnProperty.call(record, name)) {
      hits.push(record[name]);
    }
    for (const value of Object.values(record)) collectDescendant(value, name, hits);
  }
  function evaluateJsonPath(path, root) {
    const parsed = parseJsonPath(path);
    if (!parsed.ok) return parsed;
    let current = [root];
    for (const segment of parsed.segments) {
      const next = [];
      for (const value of current) next.push(...applySegment(value, segment));
      current = next;
    }
    return { ok: true, values: current };
  }

  // flow-engine/src/json-schema-lite.ts
  var SUPPORTED_TYPES = [
    "object",
    "array",
    "string",
    "number",
    "integer",
    "boolean",
    "null"
  ];
  function isPlainObject2(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function matchesType(value, type) {
    switch (type) {
      case "object":
        return isPlainObject2(value);
      case "array":
        return Array.isArray(value);
      case "string":
        return typeof value === "string";
      case "number":
        return typeof value === "number";
      case "integer":
        return typeof value === "number" && Number.isInteger(value);
      case "boolean":
        return typeof value === "boolean";
      case "null":
        return value === null;
      default:
        return false;
    }
  }
  function validateJsonSchemaLite(schema, value, path = "$") {
    const errors = [];
    if (!isPlainObject2(schema)) {
      return {
        ok: false,
        errors: [`${path} \u7684 schema \u914D\u7F6E\u975E\u6CD5\uFF1A\u9700\u4E3A\u5BF9\u8C61\uFF08\u5F97\u5230 ${describeType(schema)}\uFF09`]
      };
    }
    const rawType = schema["type"];
    if (rawType !== void 0) {
      const types = Array.isArray(rawType) ? rawType : [rawType];
      const invalid = types.find(
        (entry) => typeof entry !== "string" || !SUPPORTED_TYPES.includes(entry)
      );
      if (types.length === 0 || invalid !== void 0) {
        errors.push(
          `${path} \u7684 schema \u914D\u7F6E\u975E\u6CD5\uFF1Atype \u9700\u4E3A ${SUPPORTED_TYPES.join(" / ")} \u6216\u5176\u6570\u7EC4\uFF08\u5F97\u5230 ${JSON.stringify(rawType) ?? String(rawType)}\uFF09`
        );
      } else if (!types.some((type) => matchesType(value, type))) {
        errors.push(`${path} \u7684\u7C7B\u578B\u4E0D\u7B26\uFF1A\u671F\u671B ${types.join(" | ")}\uFF0C\u5B9E\u9645 ${describeType(value)}`);
      }
    }
    const rawEnum = schema["enum"];
    if (rawEnum !== void 0) {
      if (!Array.isArray(rawEnum) || rawEnum.length === 0) {
        errors.push(
          `${path} \u7684 schema \u914D\u7F6E\u975E\u6CD5\uFF1Aenum \u9700\u4E3A\u975E\u7A7A\u6570\u7EC4\uFF08\u5F97\u5230 ${JSON.stringify(rawEnum) ?? String(rawEnum)}\uFF09`
        );
      } else if (!rawEnum.some((candidate) => jsonDeepEqual(candidate, value))) {
        errors.push(
          `${path} \u4E0D\u5728\u679A\u4E3E\u8303\u56F4\u5185\uFF1A\u671F\u671B ${JSON.stringify(rawEnum) ?? String(rawEnum)} \u4E4B\u4E00\uFF0C\u5B9E\u9645 ${JSON.stringify(value) ?? String(value)}`
        );
      }
    }
    const rawProperties = schema["properties"];
    if (rawProperties !== void 0 && !isPlainObject2(rawProperties)) {
      errors.push(`${path} \u7684 schema \u914D\u7F6E\u975E\u6CD5\uFF1Aproperties \u9700\u4E3A\u5BF9\u8C61`);
    }
    const rawRequired = schema["required"];
    if (rawRequired !== void 0 && (!Array.isArray(rawRequired) || !rawRequired.every((entry) => typeof entry === "string"))) {
      errors.push(
        `${path} \u7684 schema \u914D\u7F6E\u975E\u6CD5\uFF1Arequired \u9700\u4E3A\u5B57\u7B26\u4E32\u6570\u7EC4\uFF08\u5F97\u5230 ${JSON.stringify(rawRequired) ?? String(rawRequired)}\uFF09`
      );
    }
    if (isPlainObject2(value)) {
      if (Array.isArray(rawRequired)) {
        for (const key of rawRequired) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) {
            errors.push(`${path} \u7F3A\u5C11\u5FC5\u586B\u5C5E\u6027 "${key}"`);
          }
        }
      }
      if (isPlainObject2(rawProperties)) {
        for (const [key, childSchema] of Object.entries(rawProperties)) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          const child = validateJsonSchemaLite(childSchema, value[key], `${path}.${key}`);
          if (!child.ok) errors.push(...child.errors);
        }
      }
    }
    const rawItems = schema["items"];
    if (rawItems !== void 0 && Array.isArray(value)) {
      if (!isPlainObject2(rawItems)) {
        errors.push(`${path} \u7684 schema \u914D\u7F6E\u975E\u6CD5\uFF1Aitems \u9700\u4E3A\u5BF9\u8C61\u5F62\u5F0F\u7684 schema`);
      } else {
        for (let index = 0; index < value.length; index++) {
          const child = validateJsonSchemaLite(rawItems, value[index], `${path}[${index}]`);
          if (!child.ok) errors.push(...child.errors);
        }
      }
    }
    return errors.length === 0 ? { ok: true } : { ok: false, errors };
  }
  function describeType(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    switch (typeof value) {
      case "object":
        return "object";
      case "string":
        return "string";
      case "number":
        return Number.isInteger(value) ? "integer" : "number";
      case "boolean":
        return "boolean";
      case "undefined":
        return "undefined";
      default:
        return typeof value;
    }
  }

  // flow-engine/src/assert-nodes.ts
  function extractStatusValue(input) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return void 0;
    const status = input["status"];
    return typeof status === "number" && Number.isFinite(status) ? status : void 0;
  }
  var STATUS_RANGES = {
    "2xx": { min: 200, max: 299, label: "2xx\uFF08200~299\uFF09" },
    "3xx": { min: 300, max: 399, label: "3xx\uFF08300~399\uFF09" },
    "4xx": { min: 400, max: 499, label: "4xx\uFF08400~499\uFF09" },
    "5xx": { min: 500, max: 599, label: "5xx\uFF08500~599\uFF09" }
  };
  function describeValue(value, max = 120) {
    let text;
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
    return text.length <= max ? text : `${text.slice(0, max)}\u2026`;
  }
  function describeAssertionRule(rule) {
    if (rule.kind === "status") {
      return rule.op === "eq" ? `\u72B6\u6001\u7801 = ${rule.value}` : `\u72B6\u6001\u7801 ${rule.op}`;
    }
    if (rule.kind === "jsonPath") {
      const opLabel = {
        eq: "\u7B49\u4E8E",
        ne: "\u4E0D\u7B49\u4E8E",
        contains: "\u5305\u542B",
        regex: "\u5339\u914D\u6B63\u5219",
        exists: "\u5B58\u5728"
      };
      return opLabel[rule.op] === "\u5B58\u5728" ? `${rule.path} \u5B58\u5728` : `${rule.path} ${opLabel[rule.op]} ${describeValue(rule.value)}`;
    }
    return `Schema \u6821\u9A8C ${rule.path && rule.path.trim() !== "" ? rule.path : "$"}`;
  }
  function evaluateStatusRule(rule, input) {
    const label = describeAssertionRule(rule);
    const actual = extractStatusValue(input);
    if (actual === void 0) {
      return {
        ok: false,
        label,
        message: "\u5165\u53C2\u4E0D\u542B\u6570\u5B57 status \u5B57\u6BB5\uFF08\u72B6\u6001\u7801\u65AD\u8A00\u7684\u76EE\u6807\u5E94\u662F\u8BF7\u6C42\u91CD\u653E\u8282\u70B9\u7684\u54CD\u5E94\u8F93\u51FA\uFF09"
      };
    }
    if (rule.op === "eq") {
      const expected = rule.value;
      if (typeof expected !== "number" || !Number.isFinite(expected)) {
        return { ok: false, label, message: "\u89C4\u5219\u914D\u7F6E\u975E\u6CD5\uFF1A\u300C\u7B49\u4E8E\u300D\u6BD4\u8F83\u9700\u63D0\u4F9B\u6574\u6570\u72B6\u6001\u7801\uFF08\u5982 200\uFF09" };
      }
      return actual === expected ? { ok: true, label } : { ok: false, label, message: `\u671F\u671B ${expected}\uFF0C\u5B9E\u9645 ${actual}` };
    }
    const range = STATUS_RANGES[rule.op];
    return actual >= range.min && actual <= range.max ? { ok: true, label } : { ok: false, label, message: `\u671F\u671B\u843D\u5728 ${range.label}\uFF0C\u5B9E\u9645 ${actual}` };
  }
  function evaluateJsonPathRule(rule, input) {
    const label = describeAssertionRule(rule);
    const parsed = evaluateJsonPath(rule.path, input);
    if (!parsed.ok) {
      return { ok: false, label, message: `\u8DEF\u5F84\u8BED\u6CD5\u975E\u6CD5\uFF1A${parsed.error}` };
    }
    const { values } = parsed;
    if (rule.op === "exists") {
      return values.length > 0 ? { ok: true, label } : { ok: false, label, message: `\u671F\u671B\u8DEF\u5F84\u5B58\u5728\u81F3\u5C11\u4E00\u4E2A\u5339\u914D\u503C\uFF0C\u5B9E\u9645\u65E0\u5339\u914D\uFF08\u5171 0 \u4E2A\uFF09` };
    }
    if (values.length === 0) {
      return {
        ok: false,
        label,
        message: "\u8DEF\u5F84\u65E0\u5339\u914D\u503C\uFF08\u4E0D\u5B58\u5728\u6216\u8DEF\u5F84\u5199\u9519\uFF1B\u300C\u5B58\u5728\u300D\u7C7B\u68C0\u67E5\u8BF7\u6539\u7528 exists\uFF09"
      };
    }
    for (const actual of values) {
      const failure = compareJsonPathValue(rule, actual);
      if (failure !== null) return { ok: false, label, message: failure };
    }
    return { ok: true, label };
  }
  function compareJsonPathValue(rule, actual) {
    const expected = rule.value;
    const actualText = describeValue(actual);
    switch (rule.op) {
      case "eq":
        return jsonDeepEqual(expected, actual) ? null : `\u671F\u671B ${describeValue(expected)}\uFF0C\u5B9E\u9645 ${actualText}`;
      case "ne":
        return jsonDeepEqual(expected, actual) ? `\u671F\u671B\u4E0D\u7B49\u4E8E ${describeValue(expected)}\uFF0C\u5B9E\u9645\u6070\u597D\u76F8\u7B49` : null;
      case "contains": {
        if (typeof actual === "string") {
          const needle = typeof expected === "string" ? expected : describeValue(expected);
          return actual.includes(needle) ? null : `\u671F\u671B\u5305\u542B ${describeValue(needle)}\uFF0C\u5B9E\u9645 ${actualText}`;
        }
        if (Array.isArray(actual)) {
          return actual.some((item) => jsonDeepEqual(item, expected)) ? null : `\u671F\u671B\u6570\u7EC4\u5305\u542B\u5143\u7D20 ${describeValue(expected)}\uFF0C\u5B9E\u9645 ${actualText}`;
        }
        return `\u300C\u5305\u542B\u300D\u53EA\u652F\u6301\u5B57\u7B26\u4E32\u6216\u6570\u7EC4\u76EE\u6807\uFF0C\u5B9E\u9645\u4E3A ${actualText}`;
      }
      case "regex": {
        if (typeof expected !== "string" || expected.trim() === "") {
          return "\u89C4\u5219\u914D\u7F6E\u975E\u6CD5\uFF1A\u6B63\u5219\u6BD4\u8F83\u9700\u63D0\u4F9B\u975E\u7A7A\u7684\u6B63\u5219\u6E90\u6587\u672C\uFF08\u5B57\u7B26\u4E32\uFF09";
        }
        let pattern;
        try {
          pattern = new RegExp(expected);
        } catch (error) {
          return `\u6B63\u5219\u8868\u8FBE\u5F0F\u975E\u6CD5\uFF1A${error instanceof Error ? error.message : String(error)}`;
        }
        if (typeof actual !== "string") {
          return `\u300C\u6B63\u5219\u300D\u53EA\u652F\u6301\u5B57\u7B26\u4E32\u76EE\u6807\uFF0C\u5B9E\u9645\u4E3A ${actualText}`;
        }
        return pattern.test(actual) ? null : `\u671F\u671B\u5339\u914D /${expected}/\uFF0C\u5B9E\u9645 ${actualText}`;
      }
      case "exists":
        return null;
    }
  }
  function evaluateSchemaRule(rule, input) {
    const label = describeAssertionRule(rule);
    if (rule.schema === null || typeof rule.schema !== "object" || Array.isArray(rule.schema)) {
      return { ok: false, label, message: '\u89C4\u5219\u914D\u7F6E\u975E\u6CD5\uFF1Aschema \u9700\u4E3A\u5BF9\u8C61\uFF08\u5982 {"type":"object"}\uFF09' };
    }
    let target = input;
    const path = typeof rule.path === "string" ? rule.path.trim() : "";
    if (path !== "") {
      const located = evaluateJsonPath(path, input);
      if (!located.ok) {
        return { ok: false, label, message: `\u76EE\u6807\u8DEF\u5F84\u8BED\u6CD5\u975E\u6CD5\uFF1A${located.error}` };
      }
      if (located.values.length === 0) {
        return { ok: false, label, message: `\u76EE\u6807\u8DEF\u5F84\u65E0\u5339\u914D\u503C\uFF1A${path}\uFF08\u4E0D\u5B58\u5728\u6216\u8DEF\u5F84\u5199\u9519\uFF09` };
      }
      target = located.values[0];
    }
    const result = validateJsonSchemaLite(rule.schema, target);
    if (result.ok) return { ok: true, label };
    return {
      ok: false,
      label,
      message: `Schema \u6821\u9A8C\u672A\u901A\u8FC7\uFF08${result.errors.length} \u5904\uFF09\uFF1A${result.errors.join("\uFF1B")}`
    };
  }
  function evaluateAssertions(rules, input) {
    const failures = [];
    rules.forEach((rule, position) => {
      const index = position + 1;
      const outcome = evaluateSingleAssertion(rule, input);
      if (!outcome.ok) {
        failures.push({ index, label: outcome.label, message: outcome.message });
      }
    });
    return failures;
  }
  function evaluateSingleAssertion(rule, input) {
    if (rule === null || typeof rule !== "object" || Array.isArray(rule)) {
      return {
        ok: false,
        label: "<\u672A\u77E5\u89C4\u5219>",
        message: "\u89C4\u5219\u914D\u7F6E\u975E\u6CD5\uFF1A\u9700\u4E3A\u5BF9\u8C61\uFF08kind: status / jsonPath / schema\uFF09"
      };
    }
    const candidate = rule;
    switch (candidate.kind) {
      case "status":
        return evaluateStatusRule(candidate, input);
      case "jsonPath":
        return evaluateJsonPathRule(candidate, input);
      case "schema":
        return evaluateSchemaRule(candidate, input);
      default:
        return {
          ok: false,
          label: "<\u672A\u77E5\u89C4\u5219>",
          message: `\u89C4\u5219\u914D\u7F6E\u975E\u6CD5\uFF1Akind \u9700\u4E3A status / jsonPath / schema \u4E4B\u4E00\uFF08\u5F97\u5230 ${describeValue(candidate.kind)}\uFF09`
        };
    }
  }
  function formatAssertionFailures(failures) {
    const lines = failures.map(
      (failure) => `\u7B2C ${failure.index} \u6761\u89C4\u5219\uFF08${failure.label}\uFF09\uFF1A${failure.message}`
    );
    const head = failures.length === 1 ? "\u65AD\u8A00\u5931\u8D25" : `\u65AD\u8A00\u5931\u8D25\uFF08\u5171 ${failures.length} \u6761\u4E0D\u901A\u8FC7\uFF09`;
    return `${head}
${lines.join("\n")}`;
  }
  function resolveAssertionRules(config) {
    return Array.isArray(config.assertions) ? config.assertions : [];
  }
  function createAssertRunner() {
    return async (node, input) => {
      const rules = resolveAssertionRules(node.config);
      if (rules.length === 0) return input;
      const failures = evaluateAssertions(rules, input);
      if (failures.length > 0) throw new Error(formatAssertionFailures(failures));
      return input;
    };
  }

  // flow-engine/src/transform-nodes.ts
  var import_jmespath = __toESM(require_jmespath(), 1);
  function toErrorMessage4(error) {
    if (error instanceof Error) return error.message;
    return String(error);
  }
  function extractByJsonPath(input, path) {
    const evaluated = evaluateJsonPath(path, input);
    if (evaluated.ok) {
      if (evaluated.values.length === 0) return null;
      return evaluated.values.length === 1 ? evaluated.values[0] : evaluated.values;
    }
    throw new Error(`JSONPath \u8BED\u6CD5\u975E\u6CD5\uFF1A${path}\uFF08${evaluated.error}\uFF09`);
  }
  function extractByJmesPath(input, path) {
    let result;
    try {
      result = (0, import_jmespath.search)(input, path);
    } catch (error) {
      throw new Error(`JMESPath \u8868\u8FBE\u5F0F\u975E\u6CD5\uFF1A${path}\uFF08${toErrorMessage4(error)}\uFF09`);
    }
    return result === void 0 ? null : result;
  }
  function extractByRule(rule, input) {
    if (rule.engine === "jsonPath") {
      try {
        return extractByJsonPath(input, rule.path);
      } catch (error) {
        throw new Error(`\u63D0\u53D6\u89C4\u5219 ${rule.name}\uFF1A${toErrorMessage4(error)}`);
      }
    }
    if (rule.engine === "jmespath") {
      try {
        return extractByJmesPath(input, rule.path);
      } catch (error) {
        throw new Error(`\u63D0\u53D6\u89C4\u5219 ${rule.name}\uFF1A${toErrorMessage4(error)}`);
      }
    }
    throw new Error(`\u63D0\u53D6\u89C4\u5219 ${rule.name} \u7684 engine \u975E\u6CD5\uFF1A${String(rule.engine)}`);
  }
  function evaluateExtractions(rules, input) {
    if (!Array.isArray(rules) || rules.length === 0) return input;
    const cleaned = rules.map((rule, index) => {
      if (rule === null || typeof rule !== "object") {
        throw new Error(`\u7B2C ${index + 1} \u6761\u63D0\u53D6\u89C4\u5219\u5F62\u72B6\u975E\u6CD5\uFF1A\u9700\u4E3A { name, engine, path } \u5BF9\u8C61`);
      }
      const candidate = rule;
      if (typeof candidate.name !== "string" || candidate.name === "") {
        throw new Error(`\u7B2C ${index + 1} \u6761\u63D0\u53D6\u89C4\u5219\u7F3A\u5C11\u89C4\u5219\u540D\uFF08name\uFF09`);
      }
      if (typeof candidate.path !== "string") {
        throw new Error(`\u63D0\u53D6\u89C4\u5219 ${candidate.name} \u7F3A\u5C11\u67E5\u8BE2\u8868\u8FBE\u5F0F\uFF08path\uFF09`);
      }
      if (candidate.engine !== "jsonPath" && candidate.engine !== "jmespath") {
        throw new Error(`\u63D0\u53D6\u89C4\u5219 ${candidate.name} \u7684 engine \u975E\u6CD5\uFF1A${String(candidate.engine)}`);
      }
      return candidate;
    });
    if (cleaned.length === 1) {
      const rule = cleaned[0];
      return extractByRule(rule, input);
    }
    const grouped = {};
    for (const rule of cleaned) {
      grouped[rule.name] = extractByRule(rule, input);
    }
    return grouped;
  }
  function createTransformRunner() {
    return async (node, input) => evaluateExtractions(node.config.extractions, input);
  }

  // flow-engine/src/replay-response.ts
  function readResponseHeader(headers, name) {
    const lowered = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === lowered) return value;
    }
    return void 0;
  }
  function detectResponseBody(bodyText, headers = {}) {
    if (bodyText === "") return { bodyType: "empty" };
    const contentType = readResponseHeader(headers, "content-type")?.toLowerCase() ?? "";
    const trimmed = bodyText.trim();
    const contentTypeSaysJson = contentType.includes("json");
    const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[");
    if (!contentTypeSaysJson && !looksLikeJson) {
      return { bodyType: "text" };
    }
    try {
      return { bodyType: "json", json: JSON.parse(bodyText) };
    } catch {
      return { bodyType: "text" };
    }
  }

  // flow-engine/src/url-lite.ts
  var DEFAULT_PORTS = {
    "http:": "80",
    "https:": "443",
    "ws:": "80",
    "wss:": "443",
    "ftp:": "21"
  };
  var SPECIAL_SCHEMES = /* @__PURE__ */ new Set(["http:", "https:", "ws:", "wss:"]);
  function urlDecodePercent(text) {
    if (!text.includes("%") && !text.includes("+")) return text;
    let out = "";
    let utf8Buffer = [];
    const flushUtf8 = () => {
      if (utf8Buffer.length === 0) return;
      const buffer = utf8Buffer;
      utf8Buffer = [];
      let index = 0;
      while (index < buffer.length) {
        const byte = buffer[index];
        let code;
        let length;
        if (byte < 128) {
          code = byte;
          length = 1;
        } else if ((byte & 224) === 192 && index + 1 < buffer.length && (buffer[index + 1] & 192) === 128) {
          code = (byte & 31) << 6 | buffer[index + 1] & 63;
          length = 2;
        } else if ((byte & 240) === 224 && index + 2 < buffer.length && (buffer[index + 1] & 192) === 128 && (buffer[index + 2] & 192) === 128) {
          code = (byte & 15) << 12 | (buffer[index + 1] & 63) << 6 | buffer[index + 2] & 63;
          length = 3;
        } else if ((byte & 248) === 240 && index + 3 < buffer.length && (buffer[index + 1] & 192) === 128 && (buffer[index + 2] & 192) === 128 && (buffer[index + 3] & 192) === 128) {
          code = (byte & 7) << 18 | (buffer[index + 1] & 63) << 12 | (buffer[index + 2] & 63) << 6 | buffer[index + 3] & 63;
          length = 4;
        } else {
          code = 65533;
          length = 1;
        }
        if (code >= 65536) {
          const offset = code - 65536;
          out += String.fromCharCode(55296 + (offset >> 10), 56320 + (offset & 1023));
        } else {
          out += String.fromCharCode(code);
        }
        index += length;
      }
    };
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (char === "+") {
        flushUtf8();
        out += " ";
      } else if (char === "%") {
        const hex = text.slice(index + 1, index + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          utf8Buffer.push(Number.parseInt(hex, 16));
          index += 2;
        } else {
          flushUtf8();
          out += "%";
        }
      } else {
        flushUtf8();
        out += char;
      }
    }
    flushUtf8();
    return out;
  }
  function parseUrl(raw) {
    const text = raw.replace(/^[\u0000-\u0020]+/, "").replace(/[\u0000-\u0020]+$/, "").replace(/[\t\n\r]/g, "");
    const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(text);
    if (schemeMatch === null) return null;
    const protocol = `${schemeMatch[1].toLowerCase()}:`;
    const isSpecial = SPECIAL_SCHEMES.has(protocol);
    let authorityEnd = text.length;
    for (let index = schemeMatch[0].length; index < text.length; index++) {
      const char = text[index];
      if (char === "/" || char === "?" || char === "#") {
        authorityEnd = index;
        break;
      }
    }
    let authority = text.slice(schemeMatch[0].length, authorityEnd);
    const rest = text.slice(authorityEnd);
    const hashAt = rest.indexOf("#");
    const hash = hashAt === -1 ? "" : rest.slice(hashAt);
    const beforeHash = hashAt === -1 ? rest : rest.slice(0, hashAt);
    const searchAt = beforeHash.indexOf("?");
    const search = searchAt === -1 ? "" : beforeHash.slice(searchAt);
    const rawPathname = searchAt === -1 ? beforeHash : beforeHash.slice(0, searchAt);
    const pathname = rawPathname === "" ? "/" : rawPathname;
    const userinfoAt = authority.lastIndexOf("@");
    if (userinfoAt !== -1) authority = authority.slice(userinfoAt + 1);
    let hostname = "";
    let port = "";
    if (authority.startsWith("[")) {
      const close = authority.indexOf("]");
      if (close === -1) return null;
      hostname = authority.slice(0, close + 1);
      const remainder = authority.slice(close + 1);
      if (remainder !== "") {
        if (!remainder.startsWith(":")) return null;
        port = remainder.slice(1);
      }
    } else {
      const colonAt = authority.lastIndexOf(":");
      if (colonAt === -1) {
        hostname = authority;
      } else {
        hostname = authority.slice(0, colonAt);
        port = authority.slice(colonAt + 1);
      }
    }
    if (hostname === "") return null;
    hostname = hostname.toLowerCase();
    if (port !== "") {
      if (!/^\d+$/.test(port)) return null;
      const numeric = Number.parseInt(port, 10);
      if (numeric > 65535) return null;
      port = String(numeric);
    }
    const defaultPort = DEFAULT_PORTS[protocol];
    const effectivePort = port !== "" && port !== defaultPort ? port : "";
    const origin = isSpecial ? `${protocol}//${hostname}${effectivePort !== "" ? `:${effectivePort}` : ""}` : "null";
    const entries = [];
    if (search.length > 1) {
      for (const pair of search.slice(1).split("&")) {
        if (pair === "") continue;
        const eq = pair.indexOf("=");
        if (eq === -1) {
          entries.push([urlDecodePercent(pair), ""]);
        } else {
          entries.push([urlDecodePercent(pair.slice(0, eq)), urlDecodePercent(pair.slice(eq + 1))]);
        }
      }
    }
    const searchParams = {
      entries() {
        return entries[Symbol.iterator]();
      },
      get(name) {
        return entries.find(([entryName]) => entryName === name)?.[1];
      }
    };
    return {
      protocol,
      host: `${hostname}${effectivePort !== "" ? `:${effectivePort}` : ""}`,
      hostname,
      port: effectivePort,
      origin,
      pathname,
      search,
      hash,
      searchParams
    };
  }

  // flow-engine/src/header-fidelity.ts
  var HEADER_FIDELITY_TARGETS = {
    origin: "Origin",
    referer: "Referer",
    userAgent: "User-Agent"
  };
  function findCapturedHeader(harEntry, headerName) {
    const lowered = headerName.toLowerCase();
    for (const header of harEntry.request.headers) {
      if (header.name.toLowerCase() === lowered) return header.value;
    }
    return void 0;
  }
  function resolveDecision(key, item, harEntry, templateContext) {
    const header = HEADER_FIDELITY_TARGETS[key];
    if (item.source === "fromCapture") {
      const captured = findCapturedHeader(harEntry, header);
      if (captured === void 0) return void 0;
      return { key, header, value: captured, source: "fromCapture" };
    }
    const raw = typeof item.value === "string" ? item.value : "";
    const rendered = templateContext ? renderTemplate(raw, templateContext).value : raw;
    if (rendered.trim() === "") return void 0;
    return { key, header, value: rendered, source: "static" };
  }
  function resolveHeaderFidelityPlan(params) {
    const { fidelity, harEntry, templateContext } = params;
    const removed = new Set((params.removedHeaders ?? []).map((name) => name.trim().toLowerCase()));
    const decisions = [];
    for (const key of Object.keys(HEADER_FIDELITY_TARGETS)) {
      const header = HEADER_FIDELITY_TARGETS[key];
      if (removed.has(header.toLowerCase())) continue;
      const item = fidelity?.[key] ?? { source: "fromCapture" };
      const decision = resolveDecision(key, item, harEntry, templateContext);
      if (decision) decisions.push(decision);
    }
    return decisions;
  }
  var COOKIE_HEADER_NAME = "Cookie";
  function extractSnapshotCookie(harEntry) {
    const cookies = harEntry.request.cookies;
    if (Array.isArray(cookies)) {
      const parts = [];
      for (const cookie of cookies) {
        if (typeof cookie?.name !== "string" || cookie.name === "") continue;
        parts.push(`${cookie.name}=${typeof cookie.value === "string" ? cookie.value : ""}`);
      }
      if (parts.length > 0) return parts.join("; ");
    }
    const header = harEntry.request.headers.find(
      (item) => item.name.toLowerCase() === COOKIE_HEADER_NAME.toLowerCase()
    )?.value;
    if (typeof header === "string" && header.trim() !== "") return header.trim();
    return void 0;
  }
  function resolveCookieDecision(params) {
    const { mode, cookieValue, harEntry, templateContext } = params;
    const removed = (params.removedHeaders ?? []).some(
      (name) => name.trim().toLowerCase() === COOKIE_HEADER_NAME.toLowerCase()
    );
    if (removed) return void 0;
    if (mode === "custom") {
      const raw = typeof cookieValue === "string" ? cookieValue : "";
      const rendered2 = templateContext ? renderTemplate(raw, templateContext).value : raw;
      if (rendered2.trim() === "") return void 0;
      return { key: "cookie", header: COOKIE_HEADER_NAME, value: rendered2, source: "static" };
    }
    const captured = extractSnapshotCookie(harEntry);
    if (captured === void 0) return void 0;
    const rendered = templateContext ? renderTemplate(captured, templateContext).value : captured;
    if (rendered.trim() === "") return void 0;
    return { key: "cookie", header: COOKIE_HEADER_NAME, value: rendered, source: "snapshot" };
  }
  function escapeRegExp2(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function buildOriginRegexFilter(url) {
    const parsed = parseUrl(url);
    if (parsed === null) return null;
    const origin = parsed.origin;
    if (origin === "" || origin === "null") return null;
    return `^${escapeRegExp2(origin)}/`;
  }
  function buildHeaderFidelityRule(params) {
    const { targetUrl, decisions } = params;
    if (decisions.length === 0) return null;
    const regexFilter = buildOriginRegexFilter(targetUrl);
    if (regexFilter === null) return null;
    return {
      priority: 1,
      condition: {
        regexFilter,
        // [-1]：仅匹配扩展自身发起（不关联 tab）的请求，页面流量不受影响
        tabIds: [-1]
      },
      action: {
        type: "modifyHeaders",
        requestHeaders: decisions.map((decision) => ({
          header: decision.header,
          operation: "set",
          value: decision.value
        }))
      }
    };
  }

  // flow-engine/src/run-variables.ts
  function mergeVariableScopes(scopes) {
    const merged = {};
    for (const table of [scopes.global, scopes.project, scopes.workflow]) {
      if (table === null || typeof table !== "object" || Array.isArray(table)) continue;
      Object.assign(merged, table);
    }
    return merged;
  }
  var RunVariableStore = class {
    /** 当前变量表（构造时浅拷贝初始表） */
    #values;
    /**
     * @param initial 初始变量表（缺省空表；浅拷贝保存，外部改动不影响本 store）
     */
    constructor(initial = {}) {
      this.#values = { ...initial };
    }
    /** 读取变量值；变量不存在返回 undefined（与「存在但值就是 undefined」不区分） */
    get(name) {
      return this.#values[name];
    }
    /** 变量是否存在（hasOwnProperty 精确匹配，原型链键不算） */
    has(name) {
      return Object.prototype.hasOwnProperty.call(this.#values, name);
    }
    /**
     * 写入变量（同名覆盖；值可为任意 JSON）。
     *
     * @param name 变量名（空串同样可写——键的合法性由调用方负责）
     * @param value 变量值（任意可结构化克隆的 JSON 值）
     * @returns 写入前的旧值（首次写入为 undefined，便于后续节点回显）
     */
    set(name, value) {
      const previous = this.#values[name];
      this.#values[name] = value;
      return previous;
    }
    /** 导出当前变量表的浅拷贝快照（供模板上下文构建 / 调试展示，防外部误改） */
    snapshot() {
      return { ...this.#values };
    }
    /**
     * 创建迭代作用域 overlay（M10-T6 循环并发，见 RunVariableOverlay）：读透传
     * 本 store、写缓冲私有层，mergeBack 合并回本 store。可叠加——overlay 自身
     * 同样提供 createOverlay()（嵌套循环的内层迭代以外层迭代的 overlay 为父层）。
     */
    createOverlay() {
      return new RunVariableOverlay(this);
    }
  };
  var RunVariableOverlay = class _RunVariableOverlay {
    /** 父层视图（主 store 或外层迭代的 overlay） */
    #parent;
    /** 本层写缓冲（键 → 值；合并前父层不可见） */
    #buffer = {};
    /** 缓冲键的首写序清单（mergeBack 的合并顺序与返回清单依据） */
    #keys = [];
    /**
     * @param parent 父层视图（通常经 RunVariableStore.createOverlay() /
     *   RunVariableOverlay.createOverlay() 创建，不直接构造）
     */
    constructor(parent) {
      this.#parent = parent;
    }
    /** 读取变量值：缓冲命中优先，否则透传父层（不存在返回 undefined） */
    get(name) {
      if (Object.prototype.hasOwnProperty.call(this.#buffer, name)) {
        return this.#buffer[name];
      }
      return this.#parent.get(name);
    }
    /** 变量是否存在：缓冲层或父层任一命中即成立 */
    has(name) {
      return Object.prototype.hasOwnProperty.call(this.#buffer, name) || this.#parent.has(name);
    }
    /**
     * 写入变量：缓冲到本层（父层不变），返回写入前旧值（优先取本层缓冲，
     * 首写回退父层当前值）。
     */
    set(name, value) {
      const previous = this.get(name);
      if (!Object.prototype.hasOwnProperty.call(this.#buffer, name)) {
        this.#keys.push(name);
      }
      this.#buffer[name] = value;
      return previous;
    }
    /** 导出合并视图：父层快照被本层缓冲覆盖（同名键以本层为准） */
    snapshot() {
      return { ...this.#parent.snapshot(), ...this.#buffer };
    }
    /** 创建以本 overlay 为父层的子 overlay（嵌套迭代叠加，见类说明） */
    createOverlay() {
      return new _RunVariableOverlay(this);
    }
    /**
     * 把本层缓冲合并回父层（迭代结束时的收口动作，成功 / 失败均应调用）。
     *
     * @param exclude 不参与合并的保留键（如 loop runner 的 var.loop——嵌套迭代
     *   合并时不得覆盖外层缓冲的 var.loop）。被排除的键随缓冲一并丢弃。
     * @returns 本次实际写回父层的键清单（首写序；供日志 / 调试）。缓冲已空
     *   （含重复合并）返回空数组。
     */
    mergeBack(exclude) {
      if (this.#keys.length === 0) return [];
      const skip = new Set(exclude ?? []);
      const merged = [];
      for (const key of this.#keys) {
        if (skip.has(key)) continue;
        if (!Object.prototype.hasOwnProperty.call(this.#buffer, key)) continue;
        this.#parent.set(key, this.#buffer[key]);
        merged.push(key);
      }
      this.#buffer = {};
      this.#keys = [];
      return merged;
    }
  };

  // flow-engine/src/run-workflow.ts
  function manualRequestToHarEntry(manual) {
    return {
      startedDateTime: (/* @__PURE__ */ new Date(0)).toISOString(),
      time: 0,
      request: {
        method: manual.method,
        url: manual.url,
        httpVersion: "HTTP/1.1",
        headers: Object.entries(manual.headers ?? {}).map(([name, value]) => ({ name, value })),
        queryString: [],
        headersSize: -1,
        bodySize: -1,
        ...manual.body !== void 0 ? { postData: { mimeType: "", text: manual.body } } : {}
      },
      response: {
        status: 0,
        statusText: "",
        httpVersion: "HTTP/1.1",
        headers: [],
        content: { size: 0, mimeType: "" },
        redirectURL: "",
        headersSize: -1,
        bodySize: -1
      },
      timings: { send: 0, wait: 0, receive: 0 }
    };
  }
  function resolveHarEntryForNode(node, harEntries) {
    const requestId = node.config.requestId;
    if (typeof requestId === "string" && requestId !== "") {
      const entry = harEntries?.[requestId];
      if (entry !== void 0) return entry;
    }
    const manual = node.config.manualRequest;
    return manual !== void 0 ? manualRequestToHarEntry(manual) : void 0;
  }
  function createHttpReplayRunner(deps) {
    const port = deps?.scriptPort ?? createLocalScriptPort();
    const transport = deps?.replay ?? defaultReplayTransport;
    return async (node, input, runCtx) => {
      const config = node.config;
      const templateContext = runCtx.nodeCtx.templateContext;
      const scriptOpts = templateContext.env !== void 0 ? { env: templateContext.env } : void 0;
      let extraOverride;
      if (typeof config.preProcess === "string" && config.preProcess.trim() !== "") {
        const pre = await port.runPre(config.preProcess, input, scriptOpts);
        if (pre.envWrites !== void 0) deps?.onEnvWrite?.(pre.envWrites);
        if (!pre.ok) throw new ScriptExecutionError(pre.error);
        extraOverride = pre.value;
      }
      const harEntry = resolveHarEntryForNode(node, deps?.harEntries);
      if (harEntry === void 0) {
        throw new Error(
          `\u8282\u70B9 ${node.id} \u65E0\u53EF\u7528\u8BF7\u6C42\u57FA\u7EBF\uFF08config.requestId \u672A\u547D\u4E2D\u8BF7\u6C42\u5E93\u4E14\u672A\u914D\u7F6E manualRequest\uFF09`
        );
      }
      const request = buildReplayRequest(
        { harEntry, override: config.override, extraOverride },
        templateContext
      );
      const removedHeaders = config.override?.removedHeaders;
      const decisions = [
        ...resolveHeaderFidelityPlan({
          fidelity: config.headerFidelity,
          harEntry,
          templateContext,
          removedHeaders
        })
      ];
      const cookieDecision = resolveCookieDecision({
        mode: config.cookieMode,
        cookieValue: config.cookieValue,
        harEntry,
        templateContext,
        removedHeaders
      });
      if (cookieDecision !== void 0) decisions.push(cookieDecision);
      const headers = { ...request.headers };
      for (const decision of decisions) headers[decision.header] = decision.value;
      const payload = {
        method: request.method,
        url: request.url,
        headers
      };
      if (request.body !== void 0) {
        if (typeof request.body === "string") payload.body = request.body;
        else payload.bodyBase64 = encodeBase64(request.body);
      }
      const timeoutMs = request.timeoutMs ?? config.timeoutMs;
      if (timeoutMs !== void 0) payload.timeoutMs = timeoutMs;
      const startedAt = Date.now();
      const envelope = await transport(payload);
      const body = typeof envelope.body === "string" ? envelope.body : "";
      const response = {
        status: envelope.status,
        statusText: envelope.statusText ?? "",
        headers: envelope.headers ?? {},
        body,
        durationMs: envelope.durationMs ?? Date.now() - startedAt
      };
      if (envelope.truncated === true) response.truncated = true;
      if (envelope.bodyType !== void 0) {
        response.bodyType = envelope.bodyType;
        if (envelope.json !== void 0) response.json = envelope.json;
      } else {
        const detected = detectResponseBody(body, response.headers);
        response.bodyType = detected.bodyType;
        if (detected.bodyType === "json") response.json = detected.json;
      }
      if (isHttpFailure(response)) throw new HttpFailureError(response.status, response);
      if (typeof config.postProcess === "string" && config.postProcess.trim() !== "") {
        const post = await port.runPost(config.postProcess, response, scriptOpts);
        if (post.envWrites !== void 0) deps?.onEnvWrite?.(post.envWrites);
        if (!post.ok) throw new ScriptExecutionError(post.error);
        return post.value;
      }
      return response;
    };
  }
  function defaultReplayTransport(payload) {
    const bridge = globalThis.host;
    const replay = bridge?.replay;
    if (typeof replay !== "function") {
      return Promise.reject(new Error("\u5BBF\u4E3B\u6865\u4E0D\u53EF\u7528\uFF1A\u5168\u5C40 host.replay \u672A\u6CE8\u5165\uFF0C\u65E0\u6CD5\u53D1\u8D77\u91CD\u653E"));
    }
    return replay(payload);
  }
  var HOST_CANCEL_POLL_MS = 50;
  function connectHostCancelSignal() {
    const probe = globalThis.host?.cancelled;
    if (typeof probe !== "function") return void 0;
    const source = createCancelSource();
    void (async () => {
      while (!source.signal.aborted) {
        await new Promise((resolve) => {
          hostSetTimeout(resolve, HOST_CANCEL_POLL_MS);
        });
        if (source.signal.aborted) return;
        try {
          if (await probe() === true) {
            source.cancel();
            return;
          }
        } catch {
          return;
        }
      }
    })();
    return source.signal;
  }
  async function runWorkflow(workflow, options = {}) {
    const scriptPort = options.scriptPort ?? createLocalScriptPort();
    const envSnapshot = options.env !== void 0 ? { ...options.env } : void 0;
    const handleEnvWrite = envSnapshot !== void 0 ? (writes) => {
      Object.assign(envSnapshot, writes);
      options.onEnvWrite?.(writes);
    } : void 0;
    const variableStore = new RunVariableStore(options.variables ?? {});
    const bodyPlanCache = /* @__PURE__ */ new Map();
    const getBodyPlan = (loopNodeId) => {
      let plan = bodyPlanCache.get(loopNodeId);
      if (plan === void 0) {
        plan = computeLoopBody(loopNodeId, workflow.nodes, workflow.edges);
        bodyPlanCache.set(loopNodeId, plan);
      }
      return plan;
    };
    const nestedRuns = /* @__PURE__ */ new Map();
    const pinnedOutputs = { ...options.pinnedOutputs };
    if (options.pinnedOutputs === void 0) {
      for (const node of workflow.nodes) {
        if (node.config.pinnedOutput !== void 0) {
          pinnedOutputs[node.id] = node.config.pinnedOutput.value;
        }
      }
    }
    const httpReplay = createHttpReplayRunner({
      harEntries: options.harEntries,
      scriptPort,
      ...handleEnvWrite !== void 0 ? { onEnvWrite: handleEnvWrite } : {},
      ...options.replay !== void 0 ? { replay: options.replay } : {}
    });
    const runners = {
      httpReplay,
      condition: createConditionRunner({
        scriptPort,
        ...handleEnvWrite !== void 0 ? { onEnvWrite: handleEnvWrite } : {}
      }),
      loop: createLoopRunner({
        getBodyPlan,
        getRunners: () => runners,
        getStore: () => variableStore,
        ...envSnapshot !== void 0 ? { getEnv: () => envSnapshot } : {},
        ...options.onNodeStart ? {
          forwardNodeStart: (node, input) => options.onNodeStart?.(node, input)
        } : {},
        ...options.onNodeFinish ? {
          forwardNodeFinish: (node, nodeRun) => options.onNodeFinish?.(node, nodeRun)
        } : {},
        collectNestedRun: (nodeId, nodeRun) => {
          nestedRuns.set(nodeId, nodeRun);
        }
      }),
      delay: createDelayRunner(),
      setVariable: createSetVariableRunner({ getStore: () => variableStore }),
      assert: createAssertRunner(),
      transform: createTransformRunner()
    };
    const signal = options.signal ?? connectHostCancelSignal();
    return executeWorkflow(workflow, {
      runners,
      ...signal !== void 0 ? { signal } : {},
      ...options.generateId !== void 0 ? { generateId: options.generateId } : {},
      ...options.defaultFailPolicy !== void 0 ? { defaultFailPolicy: options.defaultFailPolicy } : {},
      ...options.maxNodeConcurrency !== void 0 ? { maxNodeConcurrency: options.maxNodeConcurrency } : {},
      ...options.resume !== void 0 ? { resume: options.resume } : {},
      variables: () => variableStore.snapshot(),
      ...envSnapshot !== void 0 ? { env: () => envSnapshot } : {},
      selectDownstream: createWorkflowDownstreamSelector(workflow.nodes, workflow.edges),
      nestedNodeRun: (node) => nestedRuns.get(node.id),
      pinnedOutputs,
      ...options.onNodeStart !== void 0 ? { onNodeStart: options.onNodeStart } : {},
      ...options.onNodeFinish !== void 0 ? { onNodeFinish: options.onNodeFinish } : {},
      ...options.onRunFinish !== void 0 ? { onRunFinish: options.onRunFinish } : {}
    });
  }
  function installHostBridgeFromGlobalHost() {
    const bridge = globalThis.host;
    const sleep = bridge?.sleep;
    if (typeof sleep !== "function") return;
    setHostTimers({
      setTimeout: (callback, ms) => {
        void sleep(ms).then(
          () => callback(),
          () => void 0
        );
        return void 0;
      },
      // host.sleep 不支持按句柄取消；延时/退避的取消路径由 CancelSignal 监听器
      // 先行拒绝，迟到的 resolve 无副作用（与 QuickJS 运行时的取消语义衔接）
      clearTimeout: () => void 0
    });
  }
  installHostBridgeFromGlobalHost();

  // flow-engine/src/condition-builder.ts
  var CONDITION_OPERATORS = [
    { value: "eq", label: "\u7B49\u4E8E", needsRight: true },
    { value: "ne", label: "\u4E0D\u7B49\u4E8E", needsRight: true },
    { value: "gt", label: "\u5927\u4E8E", needsRight: true },
    { value: "gte", label: "\u5927\u4E8E\u7B49\u4E8E", needsRight: true },
    { value: "lt", label: "\u5C0F\u4E8E", needsRight: true },
    { value: "lte", label: "\u5C0F\u4E8E\u7B49\u4E8E", needsRight: true },
    { value: "contains", label: "\u5305\u542B", needsRight: true },
    { value: "notContains", label: "\u4E0D\u5305\u542B", needsRight: true },
    { value: "startsWith", label: "\u5F00\u5934\u662F", needsRight: true },
    { value: "endsWith", label: "\u7ED3\u5C3E\u662F", needsRight: true },
    { value: "isEmpty", label: "\u4E3A\u7A7A", needsRight: false },
    { value: "isNotEmpty", label: "\u4E0D\u4E3A\u7A7A", needsRight: false },
    { value: "isTrue", label: "\u4E3A\u771F", needsRight: false },
    { value: "isFalse", label: "\u4E3A\u5047", needsRight: false },
    { value: "matches", label: "\u5339\u914D\u6B63\u5219", needsRight: true }
  ];
  function findOperatorMeta(value) {
    return CONDITION_OPERATORS.find((meta) => meta.value === value);
  }
  function operatorNeedsRight(op) {
    return findOperatorMeta(op)?.needsRight ?? true;
  }
  var RUNTIME_HELPERS = [
    {
      name: "__p",
      deps: [],
      code: `const __p = (root, path) => {
  if (path === '') return root;
  let c = root;
  for (const seg of path.split('.')) {
    if (c === null || typeof c !== 'object') return undefined;
    if (Array.isArray(c)) {
      if (!/^(0|[1-9]\\d*)$/.test(seg) || Number(seg) >= c.length) return undefined;
      c = c[Number(seg)];
    } else {
      if (!Object.prototype.hasOwnProperty.call(c, seg)) return undefined;
      c = c[seg];
    }
  }
  return c;
};`
    },
    {
      name: "__s",
      deps: [],
      code: `const __s = (v) => v === undefined || v === null ? '' : typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean') ? String(v) : (JSON.stringify(v) ?? '');`
    },
    {
      name: "__nl",
      deps: [],
      code: `const __nl = (v) => typeof v === 'number' ? Number.isFinite(v) : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));`
    },
    {
      name: "__eq",
      deps: ["__nl"],
      code: `const __eq = (l, r) => __nl(l) && __nl(r) ? Number(l) === Number(r) : l === r;`
    },
    { name: "__ne", deps: ["__eq"], code: `const __ne = (l, r) => !__eq(l, r);` },
    {
      name: "__gt",
      deps: ["__nl"],
      code: `const __gt = (l, r) => __nl(l) && __nl(r) && Number(l) > Number(r);`
    },
    {
      name: "__gte",
      deps: ["__nl"],
      code: `const __gte = (l, r) => __nl(l) && __nl(r) && Number(l) >= Number(r);`
    },
    {
      name: "__lt",
      deps: ["__nl"],
      code: `const __lt = (l, r) => __nl(l) && __nl(r) && Number(l) < Number(r);`
    },
    {
      name: "__lte",
      deps: ["__nl"],
      code: `const __lte = (l, r) => __nl(l) && __nl(r) && Number(l) <= Number(r);`
    },
    {
      name: "__has",
      deps: ["__s"],
      code: `const __has = (l, r) => Array.isArray(l) ? l.some((item) => item === r || __s(item) === __s(r)) : __s(l).includes(__s(r));`
    },
    {
      name: "__starts",
      deps: ["__s"],
      code: `const __starts = (l, r) => __s(l).startsWith(__s(r));`
    },
    { name: "__ends", deps: ["__s"], code: `const __ends = (l, r) => __s(l).endsWith(__s(r));` },
    { name: "__re", deps: ["__s"], code: `const __re = (l, src) => new RegExp(src).test(__s(l));` },
    { name: "__truthy", deps: [], code: `const __truthy = (v) => Boolean(v);` },
    {
      name: "__empty",
      deps: [],
      code: `const __empty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);`
    }
  ];
  var COMPILED_HEADER = `/* ReqFlow \u6761\u4EF6\u6784\u5EFA\u5668\u7F16\u8BD1\u4EA7\u7269\uFF08\u5206\u7EC4\u6811 \u2192 \u7B49\u4EF7 JS\uFF09\uFF1B\u8BF7\u5728\u6761\u4EF6\u914D\u7F6E\u4E2D\u4FEE\u6539\uFF0C\u52FF\u624B\u6539 */`;
  function compileRefAccess(ref) {
    if (ref.kind === "input") return `__p(input, ${JSON.stringify(ref.path)})`;
    if (ref.kind === "var") {
      const path = ref.path !== "" ? `${ref.name ?? ""}.${ref.path}` : ref.name ?? "";
      return `__p(vars, ${JSON.stringify(path)})`;
    }
    return "undefined";
  }
  function compileValueTemplate(raw) {
    const tokens = parseTemplate(raw.trim());
    if (tokens.length === 1 && tokens[0].kind === "expression" && tokens[0].ref !== null) {
      return compileRefAccess(tokens[0].ref);
    }
    const parts = [];
    for (const token of tokens) {
      if (token.kind === "text") {
        parts.push(JSON.stringify(token.value));
        continue;
      }
      parts.push(token.ref !== null ? `__s(${compileRefAccess(token.ref)})` : `''`);
    }
    return parts.length > 0 ? parts.join(" + ") : `''`;
  }
  function parseRightValue(text) {
    const trimmed = text.trim();
    if (trimmed.includes("{{")) return trimmed;
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed);
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (trimmed === "null") return null;
    return trimmed;
  }
  function compileRightValue(right) {
    if (typeof right === "string") return compileValueTemplate(right);
    if (right === null) return "null";
    if (typeof right === "number" || typeof right === "boolean") return JSON.stringify(right);
    return `''`;
  }
  function rightTextOf(leaf) {
    const right = leaf.right;
    if (right === void 0 || right === null) return "";
    if (typeof right === "string") return right;
    if (typeof right === "number" || typeof right === "boolean") return String(right);
    return "";
  }
  function isBlankLeaf(leaf) {
    return leaf.left.trim() === "" && rightTextOf(leaf).trim() === "" && leaf.operator === "eq";
  }
  function compileLeaf(leaf) {
    const left = leaf.left.trim() === "" ? "input" : compileValueTemplate(leaf.left);
    const right = compileRightValue(
      typeof leaf.right === "string" ? parseRightValue(leaf.right) : leaf.right
    );
    switch (leaf.operator) {
      case "eq":
        return `__eq(${left}, ${right})`;
      case "ne":
        return `!__eq(${left}, ${right})`;
      case "gt":
        return `__gt(${left}, ${right})`;
      case "gte":
        return `__gte(${left}, ${right})`;
      case "lt":
        return `__lt(${left}, ${right})`;
      case "lte":
        return `__lte(${left}, ${right})`;
      case "contains":
        return `__has(${left}, ${right})`;
      case "notContains":
        return `!__has(${left}, ${right})`;
      case "startsWith":
        return `__starts(${left}, ${right})`;
      case "endsWith":
        return `__ends(${left}, ${right})`;
      case "isEmpty":
        return `__empty(${left})`;
      case "isNotEmpty":
        return `!__empty(${left})`;
      case "isTrue":
        return `__truthy(${left})`;
      case "isFalse":
        return `!__truthy(${left})`;
      case "matches":
        return `__re(${left}, ${right})`;
    }
  }
  function compileGroup(group, isRoot) {
    const parts = [];
    for (const child of group.children) {
      if (child.type === "group") {
        const compiled = compileGroup(child, false);
        if (compiled !== null) parts.push(compiled);
        continue;
      }
      if (isBlankLeaf(child)) continue;
      parts.push(compileLeaf(child));
    }
    if (parts.length === 0) return null;
    const inner = parts.join(group.op === "or" ? " || " : " && ");
    if (group.not === true) return `!(${inner})`;
    if (parts.length === 1) return parts[0];
    return isRoot ? inner : `(${inner})`;
  }
  function emitHelpers(needed) {
    const used = /* @__PURE__ */ new Set();
    const visit = (name) => {
      if (used.has(name)) return;
      used.add(name);
      const helper = RUNTIME_HELPERS.find((candidate) => candidate.name === name);
      if (helper) for (const dep of helper.deps) visit(dep);
    };
    for (const name of needed) visit(name);
    return RUNTIME_HELPERS.filter((helper) => used.has(helper.name)).map((helper) => helper.code).join("\n");
  }
  function compileConditionTree(tree) {
    const body = compileGroup(tree, true);
    if (body === null) return "";
    const needed = /* @__PURE__ */ new Set();
    for (const helper of RUNTIME_HELPERS) {
      if (body.includes(`${helper.name}(`)) needed.add(helper.name);
    }
    const helpers = emitHelpers(needed);
    const helperBlock = helpers !== "" ? `${helpers}
` : "";
    return `${COMPILED_HEADER}
${helperBlock}return ${body};`;
  }
  function validateValueTemplate(raw, position, slotName) {
    for (const token of parseTemplate(raw.trim())) {
      if (token.kind !== "expression") continue;
      if (token.ref === null) {
        return `\u7B2C ${position} \u6761\u6761\u4EF6\uFF1A${slotName}\u5B58\u5728\u65E0\u6CD5\u8BC6\u522B\u7684\u6A21\u677F\u5F15\u7528\uFF08{{ ${token.raw} }}\uFF09`;
      }
      if (token.ref.kind === "node" || token.ref.kind === "env" || token.ref.kind === "fake") {
        return `\u7B2C ${position} \u6761\u6761\u4EF6\uFF1A${slotName}\u7684 {{ ${token.raw} }} \u5F15\u7528\u5728\u6761\u4EF6\u8868\u8FBE\u5F0F\u4E2D\u4E0D\u53EF\u7528\uFF08\u6761\u4EF6\u6C99\u7BB1\u4EC5\u652F\u6301 input / var \u5F15\u7528\uFF09`;
      }
    }
    return null;
  }
  function validateConditionTree(tree) {
    let position = 0;
    const visit = (group) => {
      for (const child of group.children) {
        if (child.type === "group") {
          const error = visit(child);
          if (error !== null) return error;
          continue;
        }
        if (isBlankLeaf(child)) continue;
        position += 1;
        const meta = findOperatorMeta(child.operator);
        if (meta === void 0) {
          return `\u7B2C ${position} \u6761\u6761\u4EF6\uFF1A\u64CD\u4F5C\u7B26\u975E\u6CD5\uFF08${String(child.operator)}\uFF09`;
        }
        const left = child.left.trim();
        if (meta.needsRight === false) {
          if (left !== "") {
            const error = validateValueTemplate(child.left, position, "\u5DE6\u503C");
            if (error !== null) return error;
          }
          continue;
        }
        if (left === "") return `\u7B2C ${position} \u6761\u6761\u4EF6\uFF1A\u5DE6\u503C\u4E0D\u80FD\u4E3A\u7A7A`;
        const leftError = validateValueTemplate(child.left, position, "\u5DE6\u503C");
        if (leftError !== null) return leftError;
        const rightRaw = typeof child.right === "string" ? child.right : rightTextOf(child);
        const rightError = validateValueTemplate(rightRaw, position, "\u53F3\u503C");
        if (rightError !== null) return rightError;
        if (child.operator === "matches" && rightRaw.trim() !== "") {
          const tokens = parseTemplate(rightRaw);
          const hasExpression = tokens.some((token) => token.kind === "expression");
          if (!hasExpression) {
            try {
              new RegExp(rightRaw.trim());
            } catch (error) {
              return `\u7B2C ${position} \u6761\u6761\u4EF6\uFF1A\u6B63\u5219\u8868\u8FBE\u5F0F\u975E\u6CD5\uFF08${error instanceof Error ? error.message : String(error)}\uFF09`;
            }
          }
        }
      }
      return null;
    };
    return visit(tree);
  }
  function describeLeaf(leaf) {
    const left = leaf.left.trim() === "" ? "\u5165\u53C2" : leaf.left.trim();
    const meta = findOperatorMeta(leaf.operator);
    const label = meta?.label ?? String(leaf.operator);
    if (meta?.needsRight === false) return `${left} ${label}`;
    const right = rightTextOf(leaf).trim();
    return right === "" ? `${left} ${label}` : `${left} ${label} ${right}`;
  }
  function describeConditionTree(tree) {
    const describeGroup = (group, isRoot) => {
      const parts = [];
      for (const child of group.children) {
        if (child.type === "group") {
          const inner2 = describeGroup(child, false);
          if (inner2 !== "") parts.push(inner2);
          continue;
        }
        if (isBlankLeaf(child)) continue;
        parts.push(describeLeaf(child));
      }
      if (parts.length === 0) return "";
      const inner = parts.join(group.op === "or" ? " \u6216 " : " \u4E14 ");
      if (group.not === true) return `\u975E\uFF08${inner}\uFF09`;
      return !isRoot && parts.length > 1 ? `\uFF08${inner}\uFF09` : inner;
    };
    return describeGroup(tree, true);
  }
  function parseConditionLeaf(raw) {
    const record = raw !== null && typeof raw === "object" ? raw : {};
    const operator = findOperatorMeta(record.operator) !== void 0 ? record.operator : "eq";
    const leaf = {
      type: "cond",
      left: typeof record.left === "string" ? record.left : "",
      operator
    };
    const meta = findOperatorMeta(operator);
    if (meta?.needsRight !== false && record.right !== void 0) {
      const right = record.right;
      if (typeof right === "string" || typeof right === "number" || typeof right === "boolean" || right === null) {
        leaf.right = right;
      }
    }
    return leaf;
  }
  function parseConditionGroup(raw) {
    const record = raw !== null && typeof raw === "object" ? raw : {};
    const children = Array.isArray(record.children) ? record.children : [];
    return {
      type: "group",
      op: record.op === "or" ? "or" : "and",
      ...record.not === true ? { not: true } : {},
      children: children.map((child) => {
        const kind = child !== null && typeof child === "object" ? child.type : void 0;
        return kind === "group" ? parseConditionGroup(child) : parseConditionLeaf(child);
      })
    };
  }
  function parseConditionTree(raw) {
    return parseConditionGroup(raw);
  }
  function emptyConditionGroup() {
    return { type: "group", op: "and", children: [] };
  }
  function parseConditionRules(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map((item) => {
      const record = item !== null && typeof item === "object" ? item : {};
      return {
        join: record.join === "or" ? "or" : "and",
        left: typeof record.left === "string" ? record.left : "",
        op: findOperatorMeta(record.op) !== void 0 ? record.op : "eq",
        ...typeof record.right === "string" ? { right: record.right } : {}
      };
    });
  }
  function migrateConditionRules(raw) {
    const rows = parseConditionRules(raw).filter(
      (row) => !(row.left.trim() === "" && (row.right ?? "").trim() === "" && row.op === "eq")
    );
    if (rows.length === 0) return null;
    const toLeaf = (row) => ({
      type: "cond",
      left: row.left,
      operator: row.op,
      ...operatorNeedsRight(row.op) && row.right !== void 0 && row.right !== "" ? { right: parseRightValue(row.right) } : {}
    });
    const groups = [];
    let current = [];
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (index > 0 && row.join === "or") {
        groups.push({ type: "group", op: "and", children: current });
        current = [];
      }
      current.push(toLeaf(row));
    }
    groups.push({ type: "group", op: "and", children: current });
    if (groups.length === 1) return groups[0];
    return { type: "group", op: "or", children: groups };
  }

  // flow-engine/src/dependency-inference.ts
  var MIN_MATCH_VALUE_LENGTH = 4;
  var MAX_MATCH_VALUE_LENGTH = 512;
  var MAX_JSON_WALK_DEPTH = 8;
  var MAX_CANDIDATES_PER_UPSTREAM = 200;
  var JSON_EXTRACT_POST_SCRIPT = "return JSON.parse(response.body)";
  var STRUCTURAL_RESPONSE_HEADERS = /* @__PURE__ */ new Set([
    "content-type",
    "content-length",
    "content-encoding",
    "transfer-encoding",
    "date",
    "server",
    "connection",
    "cache-control",
    "expires",
    "pragma",
    "vary",
    "keep-alive",
    "age",
    "accept",
    "accept-encoding",
    "accept-language",
    "user-agent",
    "host"
  ]);
  var WRAPPED_HEADER_PATTERN = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]+(\S.*)$/;
  var TEMPLATE_CORE_PATTERN = /\{\{[\s\S]*?\}\}/;
  var PAIR_KEY_SEPARATOR = "|";
  var CONTROL_CHAR_PATTERN = new RegExp("[\\u0000-\\u001f\\u007f]");
  function isMatchableValue(value) {
    if (value.length < MIN_MATCH_VALUE_LENGTH || value.length > MAX_MATCH_VALUE_LENGTH) return false;
    if (value.trim() !== value) return false;
    if (value.includes("{{")) return false;
    if (CONTROL_CHAR_PATTERN.test(value)) return false;
    return true;
  }
  function matchableNumberValue(value) {
    if (!Number.isFinite(value)) return null;
    const text = String(value);
    if (text.length < MIN_MATCH_VALUE_LENGTH || text.length > MAX_MATCH_VALUE_LENGTH) return null;
    return text;
  }
  function canEmitJsonBodyCandidates(postProcess) {
    const trimmed = postProcess?.trim() ?? "";
    return trimmed === "" || trimmed === JSON_EXTRACT_POST_SCRIPT;
  }
  function walkJsonCandidates(value, path, depth, out) {
    if (out.length >= MAX_CANDIDATES_PER_UPSTREAM) return;
    if (typeof value === "string") {
      if (isMatchableValue(value)) out.push({ value, responsePath: path, fromJsonBody: true });
      return;
    }
    if (typeof value === "number") {
      const text = matchableNumberValue(value);
      if (text !== null) out.push({ value: text, responsePath: path, fromJsonBody: true });
      return;
    }
    if (value === null || typeof value !== "object" || depth >= MAX_JSON_WALK_DEPTH) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walkJsonCandidates(item, path === "" ? String(index) : `${path}.${index}`, depth + 1, out);
      });
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (key.includes(".")) continue;
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      walkJsonCandidates(item, path === "" ? key : `${path}.${key}`, depth + 1, out);
    }
  }
  function dedupeCandidatesByValue(candidates) {
    const best = /* @__PURE__ */ new Map();
    for (const candidate of candidates) {
      const current = best.get(candidate.value);
      if (current === void 0 || candidate.responsePath.length < current.responsePath.length) {
        best.set(candidate.value, candidate);
      }
    }
    return [...best.values()];
  }
  function collectUpstreamCandidates(record, postProcess) {
    const entry = record.har?.log?.entries?.[0];
    if (!entry) return [];
    const candidates = [];
    for (const header of entry.response?.headers ?? []) {
      const lower = header.name.toLowerCase();
      if (STRUCTURAL_RESPONSE_HEADERS.has(lower)) continue;
      if (header.value === "" || !isMatchableValue(header.value)) continue;
      candidates.push({ value: header.value, responsePath: `headers.${lower}`, fromJsonBody: false });
    }
    if (canEmitJsonBodyCandidates(postProcess)) {
      const content = entry.response?.content;
      const text = content?.text;
      if (typeof text === "string" && text !== "" && content?.encoding !== "base64") {
        try {
          const parsed = JSON.parse(text);
          walkJsonCandidates(parsed, "", 0, candidates);
        } catch {
        }
      }
    }
    return dedupeCandidatesByValue(candidates);
  }
  function normalizeBodyText(value) {
    if (typeof value === "string") return value;
    if (value !== null && typeof value === "object") {
      try {
        const serialized = JSON.stringify(value);
        return serialized ?? null;
      } catch {
        return null;
      }
    }
    return null;
  }
  function buildDownstreamSnapshot(node, record) {
    const entry = record.har?.log?.entries?.[0];
    if (!entry) return null;
    const harRequest = entry.request;
    const headers = {};
    for (const header of harRequest.headers) {
      headers[header.name] = header.value;
    }
    const override = node.config.override;
    const manualRequest = node.config.manualRequest;
    const rawMethod = override?.method ?? manualRequest?.method;
    const method = typeof rawMethod === "string" && rawMethod !== "" ? rawMethod : harRequest.method;
    const url = typeof override?.url === "string" && override.url !== "" ? override.url : manualRequest?.url ?? harRequest.url;
    if (manualRequest?.headers) Object.assign(headers, manualRequest.headers);
    if (override?.headers !== void 0) {
      for (const [key, value] of Object.entries(override.headers)) {
        if (typeof value !== "string") continue;
        headers[key] = value;
      }
    }
    if (override?.removedHeaders) {
      const removed = new Set(override.removedHeaders.map((name) => name.toLowerCase()));
      for (const name of Object.keys(headers)) {
        if (removed.has(name.toLowerCase())) delete headers[name];
      }
    }
    const overrideBody = override?.body !== void 0 ? normalizeBodyText(override.body) : null;
    const body = overrideBody ?? manualRequest?.body ?? harRequest.postData?.text;
    const snapshot = { method, url, headers };
    if (body !== void 0) snapshot.body = body;
    return snapshot;
  }
  var SLOT_KIND_ORDER = {
    "url-query": 0,
    "url-path": 1,
    header: 2,
    "body-field": 3
  };
  function urlRegionOffsets(rawUrl, parsed) {
    const pathnameStart = rawUrl.length - parsed.search.length - parsed.hash.length - parsed.pathname.length;
    return { pathnameStart, queryStart: pathnameStart + parsed.pathname.length };
  }
  function collectUrlSlots(rawUrl) {
    if (rawUrl.includes("{{")) return [];
    const parsed = parseUrl(rawUrl);
    if (parsed === null) return [];
    const { pathnameStart, queryStart } = urlRegionOffsets(rawUrl, parsed);
    const slots = [];
    const seen = /* @__PURE__ */ new Set();
    if (parsed.search.length > 0) {
      const queryRegion = rawUrl.slice(queryStart, queryStart + parsed.search.length);
      for (const [name, value] of parsed.searchParams.entries()) {
        if (value === "" || !isMatchableValue(value)) continue;
        if (!queryRegion.includes(value)) continue;
        const key = `url-query:${name}:${value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        slots.push({ key, location: { kind: "url-query", name }, value });
      }
    }
    const pathnameEnd = pathnameStart + parsed.pathname.length;
    let cursor = pathnameStart;
    while (cursor < pathnameEnd) {
      if (rawUrl[cursor] !== "/") break;
      const start = cursor + 1;
      let end = start;
      while (end < pathnameEnd && rawUrl[end] !== "/") end += 1;
      const segment = rawUrl.slice(start, end);
      if (segment !== "" && isMatchableValue(segment)) {
        const key = `url-path:${segment}`;
        if (!seen.has(key)) {
          seen.add(key);
          slots.push({ key, location: { kind: "url-path", segment }, value: segment });
        }
      }
      cursor = end;
    }
    return slots;
  }
  function collectHeaderSlots(headers) {
    const effective = stripBrowserOnlyHeaders(headers);
    const slots = [];
    const seen = /* @__PURE__ */ new Set();
    for (const [name, value] of Object.entries(effective)) {
      if (value === "" || !isMatchableValue(value)) continue;
      const lower = name.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      slots.push({ key: `header:${lower}`, location: { kind: "header", name }, value });
    }
    return slots;
  }
  function collectBodySlots(body) {
    if (body === void 0 || body === "" || body.includes("{{")) return [];
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return [];
    }
    const slots = [];
    const collect = (value, path, depth) => {
      if (typeof value === "string") {
        if (isMatchableValue(value)) {
          slots.push({ key: `body-field:${path}`, location: { kind: "body-field", path }, value });
        }
        return;
      }
      if (value === null || typeof value !== "object" || depth >= MAX_JSON_WALK_DEPTH) return;
      if (Array.isArray(value)) {
        value.forEach((item, index) => collect(item, `${path}.${index}`, depth + 1));
        return;
      }
      for (const [key, item] of Object.entries(value)) {
        if (key.includes(".")) continue;
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
        collect(item, path === "" ? key : `${path}.${key}`, depth + 1);
      }
    };
    collect(parsed, "", 0);
    return slots;
  }
  function computeDistancesToTarget(targetId, edges) {
    const reverse = /* @__PURE__ */ new Map();
    for (const edge of edges) {
      const list = reverse.get(edge.target);
      if (list) list.push(edge.source);
      else reverse.set(edge.target, [edge.source]);
    }
    const distances = /* @__PURE__ */ new Map([[targetId, 0]]);
    const queue = [targetId];
    while (queue.length > 0) {
      const current = queue.shift();
      const nextDistance = distances.get(current) + 1;
      for (const source of reverse.get(current) ?? []) {
        if (distances.has(source)) continue;
        distances.set(source, nextDistance);
        queue.push(source);
      }
    }
    return distances;
  }
  function templateExpression(upstreamRefKey, responsePath) {
    return `{{ node.${upstreamRefKey}.${responsePath} }}`;
  }
  function matchSlot(slot, upstreamRefKey, candidate) {
    const core = templateExpression(upstreamRefKey, candidate.responsePath);
    if (slot.value === candidate.value) {
      return { matchedText: slot.value, suggestedValue: core, responsePath: candidate.responsePath };
    }
    if (slot.location.kind === "header") {
      const wrapped = WRAPPED_HEADER_PATTERN.exec(slot.value);
      if (wrapped !== null && wrapped[2] === candidate.value) {
        return {
          matchedText: slot.value,
          suggestedValue: `${wrapped[1]} ${core}`,
          responsePath: candidate.responsePath
        };
      }
    }
    return null;
  }
  function locationSortKey(location) {
    switch (location.kind) {
      case "url-query":
        return location.name;
      case "url-path":
        return location.segment;
      case "header":
        return location.name.toLowerCase();
      default:
        return location.path;
    }
  }
  function matchDownstreamUpstreams(input) {
    const { downstreamNode, downstream, downstreamOrder, upstreams, edges } = input;
    const distances = computeDistancesToTarget(downstreamNode.id, edges);
    const uniqueSlots = /* @__PURE__ */ new Map();
    for (const slot of [
      ...collectUrlSlots(downstream.url),
      ...collectHeaderSlots(downstream.headers),
      ...collectBodySlots(downstream.body)
    ]) {
      if (!uniqueSlots.has(slot.key)) uniqueSlots.set(slot.key, slot);
    }
    const suggestions = [];
    for (const slot of uniqueSlots.values()) {
      const hits = [];
      for (const upstream of upstreams) {
        const upstreamRefKey = upstream.node.refId ?? upstream.node.id;
        for (const candidate of upstream.candidates) {
          const matched = matchSlot(slot, upstreamRefKey, candidate);
          if (matched === null) continue;
          hits.push({
            distance: distances.get(upstream.node.id) ?? Number.POSITIVE_INFINITY,
            negCreatedAt: -upstream.record.createdAt,
            upstreamNodeId: upstream.node.id,
            candidate,
            matched
          });
          break;
        }
      }
      if (hits.length === 0) continue;
      hits.sort((a, b) => {
        if (a.distance !== b.distance) return a.distance - b.distance;
        if (a.negCreatedAt !== b.negCreatedAt) return a.negCreatedAt - b.negCreatedAt;
        return a.upstreamNodeId < b.upstreamNodeId ? -1 : a.upstreamNodeId > b.upstreamNodeId ? 1 : 0;
      });
      const best = hits[0];
      const location = slot.location;
      suggestions.push({
        suggestion: {
          id: `${best.upstreamNodeId}=>${downstreamNode.id}:${slot.key}:${best.matched.responsePath}`,
          upstreamNodeId: best.upstreamNodeId,
          responsePath: best.matched.responsePath,
          upstreamValue: best.candidate.value,
          upstreamValueFromJsonBody: best.candidate.fromJsonBody,
          downstreamNodeId: downstreamNode.id,
          target: location,
          matchedText: best.matched.matchedText,
          suggestedValue: best.matched.suggestedValue,
          baseline: {
            method: downstream.method,
            url: downstream.url,
            ...downstream.body !== void 0 ? { body: downstream.body } : {},
            ...location.kind === "header" && downstream.headers[location.name] !== void 0 ? { headerValue: downstream.headers[location.name] } : {}
          }
        },
        rank: [downstreamOrder, SLOT_KIND_ORDER[location.kind], locationSortKey(location)]
      });
    }
    suggestions.sort((a, b) => {
      for (let i = 0; i < a.rank.length; i += 1) {
        if (a.rank[i] !== b.rank[i]) return a.rank[i] < b.rank[i] ? -1 : 1;
      }
      return 0;
    });
    return suggestions.map((ranked) => ranked.suggestion);
  }
  async function inferDependencies(input) {
    const replayNodes = input.nodes.filter(
      (node) => node.type === "httpReplay" && typeof node.config.requestId === "string"
    );
    if (replayNodes.length < 2) return [];
    const requestIds = [...new Set(replayNodes.map((node) => node.config.requestId))];
    const recordById = /* @__PURE__ */ new Map();
    await Promise.all(
      requestIds.map(async (id) => {
        try {
          recordById.set(id, await input.getRequestRecord(id));
        } catch {
          recordById.set(id, void 0);
        }
      })
    );
    const suggestions = [];
    replayNodes.forEach((downstreamNode, order) => {
      const downstreamRecord = recordById.get(downstreamNode.config.requestId);
      if (downstreamRecord === void 0) return;
      const downstream = buildDownstreamSnapshot(downstreamNode, downstreamRecord);
      if (downstream === null) return;
      const upstreams = [];
      for (const upstreamNode of replayNodes) {
        if (upstreamNode.id === downstreamNode.id) continue;
        const record = recordById.get(upstreamNode.config.requestId);
        if (record === void 0 || record.createdAt >= downstreamRecord.createdAt) continue;
        const candidates = collectUpstreamCandidates(record, upstreamNode.config.postProcess);
        if (candidates.length === 0) continue;
        upstreams.push({ node: upstreamNode, record, candidates });
      }
      if (upstreams.length === 0) return;
      suggestions.push(
        ...matchDownstreamUpstreams({
          downstreamNode,
          downstream,
          downstreamOrder: order,
          upstreams,
          edges: input.edges
        })
      );
    });
    return suggestions;
  }
  function toHttpMethodValue(value) {
    return HTTP_METHODS.find((method) => method === value) ?? "GET";
  }
  function setByJsonPath(root, path, value) {
    if (path === "") return null;
    let current = root;
    const segments = path.split(".");
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i];
      if (current === null || typeof current !== "object") return null;
      if (Array.isArray(current)) {
        const index = Number(segment);
        if (!Number.isInteger(index) || index < 0 || index >= current.length) return null;
        current = current[index];
      } else {
        const record2 = current;
        if (!Object.prototype.hasOwnProperty.call(record2, segment)) return null;
        current = record2[segment];
      }
    }
    const last = segments[segments.length - 1];
    if (current === null || typeof current !== "object") return null;
    if (Array.isArray(current)) {
      const index = Number(last);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return null;
      current[index] = value;
      return root;
    }
    const record = current;
    if (!Object.prototype.hasOwnProperty.call(record, last)) return null;
    record[last] = value;
    return root;
  }
  function substituteUrlQuery(rawUrl, paramName, value, core) {
    const queryStart = rawUrl.lastIndexOf("?");
    if (queryStart === -1) return null;
    const hashStart = rawUrl.indexOf("#", queryStart);
    const queryEnd = hashStart === -1 ? rawUrl.length : hashStart;
    const queryRegion = rawUrl.slice(queryStart, queryEnd);
    if (!queryRegion.includes(`${paramName}=`)) return null;
    const indexInRegion = queryRegion.indexOf(value);
    if (indexInRegion === -1) return null;
    const index = queryStart + indexInRegion;
    return rawUrl.slice(0, index) + core + rawUrl.slice(index + value.length);
  }
  function substituteUrlPathSegment(rawUrl, segment, core) {
    const authorityEnd = rawUrl.indexOf("//");
    const slashStart = authorityEnd === -1 ? rawUrl.indexOf("/") : rawUrl.indexOf("/", authorityEnd + 2);
    if (slashStart === -1) return null;
    const queryStart = rawUrl.indexOf("?", slashStart);
    const pathnameEnd = queryStart === -1 ? rawUrl.length : queryStart;
    let cursor = slashStart;
    while (cursor < pathnameEnd) {
      if (rawUrl[cursor] !== "/") return null;
      const start = cursor + 1;
      let end = start;
      while (end < pathnameEnd && rawUrl[end] !== "/") end += 1;
      if (rawUrl.slice(start, end) === segment) {
        return rawUrl.slice(0, start) + core + rawUrl.slice(end);
      }
      cursor = end;
    }
    return null;
  }
  function applySuggestionToConfig(config, suggestion) {
    const { target, upstreamValue, suggestedValue, baseline } = suggestion;
    const coreMatch = TEMPLATE_CORE_PATTERN.exec(suggestedValue);
    if (coreMatch === null) return null;
    const core = coreMatch[0];
    const override = config.override !== void 0 ? { ...config.override } : void 0;
    let nextOverride = override;
    if (target.kind === "header") {
      const currentValue = override?.headers?.[target.name] ?? baseline.headerValue;
      if (currentValue === void 0) return null;
      const index = currentValue.indexOf(upstreamValue);
      if (index === -1) return null;
      const nextValue = currentValue.slice(0, index) + core + currentValue.slice(index + upstreamValue.length);
      if (nextOverride === void 0) nextOverride = { method: toHttpMethodValue(baseline.method) };
      nextOverride = {
        ...nextOverride,
        headers: { ...nextOverride.headers ?? {}, [target.name]: nextValue }
      };
    } else if (target.kind === "url-query" || target.kind === "url-path") {
      const currentUrl = override?.url ?? baseline.url;
      const nextUrl = target.kind === "url-query" ? substituteUrlQuery(currentUrl, target.name, upstreamValue, core) : substituteUrlPathSegment(currentUrl, target.segment, core);
      if (nextUrl === null) return null;
      if (nextOverride === void 0) nextOverride = { method: toHttpMethodValue(baseline.method) };
      nextOverride = { ...nextOverride, url: nextUrl };
    } else {
      const rawCurrentBody = override?.body ?? baseline.body;
      if (rawCurrentBody === void 0) return null;
      const currentBody = typeof rawCurrentBody === "string" ? rawCurrentBody : normalizeBodyText(rawCurrentBody);
      if (currentBody === null) return null;
      let parsed;
      try {
        const value = JSON.parse(currentBody);
        if (value === null || typeof value !== "object") return null;
        parsed = value;
      } catch {
        return null;
      }
      const updated = setByJsonPath(parsed, target.path, core);
      if (updated === null) return null;
      let serialized;
      try {
        serialized = JSON.stringify(updated);
      } catch {
        return null;
      }
      if (serialized === void 0) return null;
      if (nextOverride === void 0) nextOverride = { method: toHttpMethodValue(baseline.method) };
      nextOverride = { ...nextOverride, body: serialized };
    }
    return { ...config, override: nextOverride };
  }
  function applySuggestions(nodes, edges, suggestions, generateId = () => hostRandomUuid()) {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const nextEdges = [...edges];
    const edgePairs = new Set(
      edges.map((edge) => `${edge.source}${PAIR_KEY_SEPARATOR}${edge.target}`)
    );
    const addedEdges = [];
    const changedSet = /* @__PURE__ */ new Set();
    const changedNodeIds = [];
    const pendingJsonUpstreams = [];
    const pendingJsonSet = /* @__PURE__ */ new Set();
    const markChanged = (nodeId) => {
      if (changedSet.has(nodeId)) return;
      changedSet.add(nodeId);
      changedNodeIds.push(nodeId);
    };
    for (const suggestion of suggestions) {
      const downstreamNode = nodeById.get(suggestion.downstreamNodeId);
      if (downstreamNode === void 0) continue;
      const nextConfig = applySuggestionToConfig(downstreamNode.config, suggestion);
      if (nextConfig === null) continue;
      nodeById.set(downstreamNode.id, { ...downstreamNode, config: nextConfig });
      markChanged(downstreamNode.id);
      const pairKey = `${suggestion.upstreamNodeId}${PAIR_KEY_SEPARATOR}${suggestion.downstreamNodeId}`;
      if (!edgePairs.has(pairKey)) {
        const edge = {
          id: asEdgeId(generateId()),
          source: asNodeId(suggestion.upstreamNodeId),
          target: asNodeId(suggestion.downstreamNodeId)
        };
        edgePairs.add(pairKey);
        nextEdges.push(edge);
        addedEdges.push(edge);
      }
      if (suggestion.upstreamValueFromJsonBody && !pendingJsonSet.has(suggestion.upstreamNodeId)) {
        const upstreamNode = nodeById.get(suggestion.upstreamNodeId);
        const postProcess = upstreamNode?.config.postProcess;
        if (upstreamNode !== void 0 && (postProcess === void 0 || postProcess.trim() === "")) {
          pendingJsonSet.add(suggestion.upstreamNodeId);
          pendingJsonUpstreams.push(suggestion.upstreamNodeId);
        }
      }
    }
    for (const upstreamId of pendingJsonUpstreams) {
      const upstreamNode = nodeById.get(upstreamId);
      nodeById.set(upstreamId, {
        ...upstreamNode,
        config: { ...upstreamNode.config, postProcess: JSON_EXTRACT_POST_SCRIPT }
      });
      markChanged(upstreamId);
    }
    const nextNodes = nodes.map((node) => nodeById.get(node.id));
    return { nodes: nextNodes, edges: nextEdges, addedEdges, changedNodeIds };
  }

  // flow-engine/src/run-graph-snapshot.ts
  var RUN_GRAPH_SNAPSHOT_MAX_BYTES = 256 * 1024;
  function safeSerialize2(value) {
    try {
      return JSON.stringify(value) ?? null;
    } catch {
      return null;
    }
  }
  function isPlainRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function readPosition(value) {
    if (isPlainRecord(value) && Number.isFinite(value["x"]) && Number.isFinite(value["y"])) {
      return { x: value["x"], y: value["y"] };
    }
    return { x: 0, y: 0 };
  }
  function cloneNodeWithoutPinned(node) {
    if (!isPlainRecord(node.config)) return { ...node, config: {} };
    const config = { ...node.config };
    delete config.pinnedOutput;
    return { ...node, config };
  }
  function cloneEdge(edge) {
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...edge.sourceHandle !== void 0 ? { sourceHandle: edge.sourceHandle } : {}
    };
  }
  function toSkeletonNode(node) {
    return {
      id: node.id,
      type: node.type,
      position: readPosition(node.position),
      config: {},
      ...typeof node.label === "string" ? { label: node.label } : {},
      ...typeof node.refId === "string" ? { refId: node.refId } : {}
    };
  }
  function buildRunGraphSnapshot(nodes, edges, options = {}) {
    const maxBytes = Math.max(0, options.maxBytes ?? RUN_GRAPH_SNAPSHOT_MAX_BYTES);
    const staged = { nodes: nodes.map(cloneNodeWithoutPinned), edges: edges.map(cloneEdge) };
    const serialized = safeSerialize2(staged);
    if (serialized !== null && utf8ByteLength(serialized) <= maxBytes) {
      const cloned = JSON.parse(serialized);
      return { nodes: cloned.nodes, edges: cloned.edges };
    }
    return {
      nodes: nodes.map(toSkeletonNode),
      edges: edges.map(cloneEdge),
      truncated: true
    };
  }

  // flow-engine/src/ref-id.ts
  var REF_ID_PATTERN = /^[A-Za-z]{5}$/;
  var REF_ID_LENGTH = 5;
  var REF_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  function isValidRefId(value) {
    return typeof value === "string" && REF_ID_PATTERN.test(value);
  }
  function randomLetters() {
    let result = "";
    if (typeof globalThis.crypto?.getRandomValues === "function") {
      const bytes = new Uint32Array(REF_ID_LENGTH);
      globalThis.crypto.getRandomValues(bytes);
      for (let i = 0; i < REF_ID_LENGTH; i++) {
        result += REF_ID_ALPHABET[bytes[i] % REF_ID_ALPHABET.length];
      }
      return result;
    }
    for (let i = 0; i < REF_ID_LENGTH; i++) {
      result += REF_ID_ALPHABET[Math.floor(Math.random() * REF_ID_ALPHABET.length)];
    }
    return result;
  }
  function generateRefId(exclude) {
    let candidate = randomLetters();
    while (exclude !== void 0 && exclude.has(candidate)) {
      candidate = randomLetters();
    }
    return candidate;
  }

  // flow-engine/src/har-cookies.ts
  var COOKIE_HEADER_NAME2 = "cookie";
  function parseCookieHeader(headerValue) {
    const cookies = [];
    for (const part of headerValue.split(";")) {
      const trimmed = part.trim();
      if (trimmed === "") continue;
      const separator = trimmed.indexOf("=");
      if (separator <= 0) continue;
      cookies.push({
        name: trimmed.slice(0, separator).trim(),
        value: trimmed.slice(separator + 1).trim()
      });
    }
    return cookies;
  }
  function withNormalizedRequestCookies(entry) {
    if (Array.isArray(entry.request.cookies)) return entry;
    const header = entry.request.headers.find(
      (item) => item.name.toLowerCase() === COOKIE_HEADER_NAME2
    );
    if (header === void 0 || header.value.trim() === "") return entry;
    const cookies = parseCookieHeader(header.value);
    if (cookies.length === 0) return entry;
    return { ...entry, request: { ...entry.request, cookies } };
  }
  return __toCommonJS(index_exports);
})();
