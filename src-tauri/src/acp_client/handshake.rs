//! Capture public authentication declarations before the SDK's v1 fallback
//! can erase unknown types. Only this connection owns executable declarations.
use agent_client_protocol::schema::v1::InitializeResponse;
use serde_json::{Value, json};
use std::collections::HashSet;

const INVALID: &str = "_farfoldInvalid";
const FORMAT: &str = "farfoldAuthFormat";
const MAX_METHODS: usize = 64;

// Intentionally neither Serialize nor Debug: terminal env/args are live only.
pub(crate) struct Handshake {
    pub(crate) typed: InitializeResponse,
    auth: Vec<Value>,
}

fn text(value: Option<&Value>, max: usize) -> Option<&str> {
    value?
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control))
}

fn strings(value: &Value) -> bool {
    value.as_array().is_some_and(|values| {
        values.len() <= 64
            && values.iter().all(|v| {
                v.as_str()
                    .is_some_and(|s| s.len() <= 4096 && !s.contains('\0'))
            })
    })
}

pub(crate) fn environment(value: &Value) -> bool {
    value.as_object().is_some_and(|values| {
        values.len() <= 64
            && values.iter().all(|(name, v)| {
                name.len() <= 256
                    && crate::manual_auth::valid_env(name)
                    && v.as_str()
                        .is_some_and(|s| s.len() <= 16384 && !s.contains('\0'))
            })
    })
}

fn vars(value: Option<&Value>) -> Option<Value> {
    let values = value?.as_array()?;
    if values.is_empty() || values.len() > 64 {
        return None;
    }
    let mut seen = HashSet::new();
    values
        .iter()
        .map(|item| {
            let name = text(item.get("name"), 256)?;
            (crate::manual_auth::valid_env(name) && seen.insert(name)).then(|| json!({"name":name}))
        })
        .collect::<Option<Vec<_>>>()
        .map(Value::Array)
}

/// Keep only fields consumed by the existing verified legacy routes. A bad
/// route remains invalid; filtering it must never produce a runnable fallback.
fn metadata(raw: &Value, method: &mut Value) -> bool {
    let Some(raw) = raw.get("_meta") else {
        return true;
    };
    let Some(raw) = raw.as_object() else {
        return false;
    };
    let mut meta = serde_json::Map::new();
    if let Some(terminal) = raw.get("terminal-auth") {
        let Some(command) = text(terminal.get("command"), 4096) else {
            return false;
        };
        let mut kept = json!({"command":command});
        if let Some(args) = terminal.get("args") {
            if !strings(args) {
                return false;
            }
            kept["args"] = args.clone();
        }
        if let Some(label) = terminal.get("label") {
            if text(Some(label), 512).is_none() {
                return false;
            }
            kept["label"] = label.clone();
        }
        // Official legacy descriptors attach environment
        // overrides here. Preserve them only in this connection's live value;
        // public/cache snapshots deliberately exclude all execution fields.
        if let Some(env) = terminal.get("env") {
            if !environment(env) {
                return false;
            }
            kept["env"] = env.clone();
        }
        meta.insert("terminal-auth".into(), kept);
    }
    if let Some(kind) = raw.get("type") {
        let Some(kind) = text(Some(kind), 64) else {
            return false;
        };
        meta.insert("type".into(), kind.into());
        if let Some(args) = raw.get("args") {
            if !strings(args) {
                return false;
            }
            meta.insert("args".into(), args.clone());
        }
    }
    if let Some(key) = raw.get("api-key") {
        let Some(key) = key.as_object() else {
            return false;
        };
        let kept = if key.contains_key("env") {
            if key.contains_key("provider") {
                return false;
            }
            let Some(name) = text(key.get("env"), 256).filter(|s| crate::manual_auth::valid_env(s))
            else {
                return false;
            };
            json!({"env":name})
        } else {
            let Some(provider) =
                text(key.get("provider"), 256).filter(|provider| provider.trim() == *provider)
            else {
                return false;
            };
            // Only declaration identity survives; payloads never become cache
            // or execution configuration. Unknown providers remain unusable.
            json!({"provider":provider})
        };
        meta.insert("api-key".into(), kept);
    }
    if !meta.is_empty() {
        method["_meta"] = meta.into();
    }
    true
}

fn declaration(raw: &Value) -> Option<Value> {
    let id = text(raw.get("id"), 256)?;
    let name = text(raw.get("name"), 512)?;
    let mut method = json!({"id":id,"name":name});
    let kind = raw.get("type");
    if let Some(kind) = kind {
        method["type"] = text(Some(kind), 64).unwrap_or("unsupported").into();
    }
    let kind = kind.and_then(Value::as_str);
    if kind == Some("env_var") {
        if let Some(vars) = vars(raw.get("vars")) {
            method["vars"] = vars;
        } else {
            method[INVALID] = true.into();
        }
        return Some(method);
    }
    if !matches!(kind, None | Some("agent" | "terminal"))
        || raw.get("type").is_some_and(|v| !v.is_string())
    {
        return Some(method);
    }
    if let Some(description) = text(raw.get("description"), 4096) {
        method["description"] = description.into();
    }
    let mut valid = true;
    if kind == Some("terminal") {
        if let Some(args) = raw.get("args") {
            valid &= strings(args);
            if valid {
                method["args"] = args.clone();
            }
        }
        // Standard terminal semantics take priority over every legacy extension.
    } else {
        valid &= metadata(raw, &mut method);
    }
    if let Some(env) = raw.get("env") {
        valid &= environment(env);
        if valid {
            method["env"] = env.clone();
        }
    }
    if !valid {
        method[INVALID] = true.into();
    }
    Some(method)
}

fn public_method(method: &Value) -> Value {
    let mut public = json!({"id":method["id"],"name":method["name"]});
    for key in ["type", "description", "vars", INVALID] {
        if let Some(value) = method.get(key) {
            public[key] = value.clone();
        }
    }
    public
}

impl Handshake {
    pub(crate) fn decode(mut raw: Value) -> Result<Self, agent_client_protocol::Error> {
        let methods = raw
            .as_object_mut()
            .ok_or_else(agent_client_protocol::Error::invalid_params)?
            .remove("authMethods")
            .unwrap_or_else(|| json!([]));
        let methods = methods
            .as_array()
            .filter(|v| v.len() <= MAX_METHODS)
            .ok_or_else(agent_client_protocol::Error::invalid_params)?;
        let mut seen = HashSet::new();
        // A malformed sibling with the same valid ID still makes that identity
        // ambiguous; do not grant authority just because its name was dropped.
        let duplicate: HashSet<_> = methods
            .iter()
            .filter_map(|m| {
                let id = text(m.get("id"), 256)?;
                (!seen.insert(id)).then(|| id.to_string())
            })
            .collect();
        let mut auth: Vec<_> = methods.iter().filter_map(declaration).collect();
        for method in &mut auth {
            if duplicate.contains(method["id"].as_str().unwrap()) {
                method[INVALID] = true.into();
            }
        }
        // No second typed copy of authentication fields can be reserialized by
        // another consumer and silently undo classification.
        let typed = serde_json::from_value(raw)
            .map_err(|_| agent_client_protocol::Error::invalid_params())?;
        Ok(Self { typed, auth })
    }

    pub(crate) fn auth_ids(&self) -> Vec<String> {
        self.auth
            .iter()
            .map(|m| m["id"].as_str().unwrap().to_string())
            .collect()
    }

    pub(crate) fn protocol_method(&self, id: &str) -> bool {
        self.auth
            .iter()
            .any(|m| m["id"] == id && super::auth_route::protocol_method(m))
    }

    pub(crate) fn protocol_api_key_provider(&self, id: &str) -> Option<&str> {
        self.auth.iter().find_map(|method| {
            (method["id"] == id)
                .then(|| super::auth_route::protocol_api_key_provider(method))
                .flatten()
        })
    }

    fn json_with_auth(&self, methods: Vec<Value>) -> Value {
        // InitializeResponse consists only of serializable schema fields.
        let mut value = serde_json::to_value(&self.typed).expect("schema serializes");
        value["authMethods"] = methods.into();
        value
    }

    pub(crate) fn public_json(&self) -> Value {
        let mut value = self.json_with_auth(self.auth.iter().map(public_method).collect());
        value[FORMAT] = 1.into();
        value
    }

    /// Ephemeral input for the existing route verifier, never stored or logged.
    pub(crate) fn execution_json(&self) -> Value {
        self.json_with_auth(self.auth.clone())
    }

    pub(crate) fn can_logout(&self) -> bool {
        self.public_json()
            .pointer("/agentCapabilities/auth/logout")
            .is_some_and(Value::is_object)
    }
}

/// Old typed snapshots may already have lost the discriminator. They provide
/// identity only, never evidence of a callable method, even at another cwd.
pub(crate) fn cached_json(raw: Option<&Value>) -> Value {
    let fresh_format = raw.and_then(|v| v.get(FORMAT)).and_then(Value::as_u64) == Some(1);
    let methods = raw
        .and_then(|v| v.get("authMethods"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_METHODS)
        .filter_map(declaration)
        .map(|mut m| {
            if !fresh_format {
                m["type"] = "unsupported".into();
            }
            public_method(&m)
        })
        .collect::<Vec<_>>();
    json!({"authMethods":methods})
}

#[cfg(test)]
mod tests;
