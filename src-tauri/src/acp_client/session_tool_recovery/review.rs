//! A complete, bounded public inventory for explicit acceptance. Private
//! descriptors remain in the existing in-memory digest comparison only.
use super::Inventory;
use serde::Serialize;
use serde_json::Value;

const LIMIT: usize = 256;
#[derive(Clone, Debug, Serialize)]
pub struct Configuration {
    complete: bool,
    items: Vec<Item>,
}
#[derive(Clone, Debug, Serialize)]
struct Item {
    name: String,
    kind: &'static str,
    address: Option<String>,
}
fn name(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|v| {
            !v.is_empty()
                && v.len() <= 256
                && !v.chars().any(|c| {
                    c.is_control() || matches!(c as u32, 0x202a..=0x202e | 0x2066..=0x2069)
                })
        })
        .map(str::to_owned)
}
fn empty(value: Option<&Value>) -> bool {
    value.is_none_or(|v| v.is_null() || v.as_array().is_some_and(Vec::is_empty))
}
pub(super) fn configuration(inventory: &Inventory) -> Option<Configuration> {
    let mut items = Vec::new();
    for entry in inventory.recovery_entries() {
        if items.len() == LIMIT {
            return None;
        }
        let object = entry.as_object()?;
        if object.keys().any(|k| {
            ![
                "type",
                "name",
                "description",
                "display_name",
                "timeout",
                "bundled",
                "available_tools",
                "server",
                "envKeys",
                "socket",
                "clientId",
                "clientSecretKey",
                "scopes",
            ]
            .contains(&k.as_str())
        }) {
            return None;
        }
        // This slice does not adopt credential, socket, environment or filtered
        // tool configurations that the current review cannot safely explain.
        if ["envKeys", "scopes", "available_tools"]
            .iter()
            .any(|k| !empty(object.get(*k)))
        {
            return None;
        }
        if ["socket", "clientId", "clientSecretKey"]
            .iter()
            .any(|k| object.get(*k).is_some_and(|v| !v.is_null()))
        {
            return None;
        }
        if ["description", "display_name"].iter().any(|k| {
            object
                .get(*k)
                .is_some_and(|v| !v.is_null() && !v.is_string())
        }) || object
            .get("timeout")
            .is_some_and(|v| !v.is_null() && v.as_u64().is_none())
            || object
                .get("bundled")
                .is_some_and(|v| !v.is_null() && !v.is_boolean())
        {
            return None;
        }
        let (kind, item_name, address) = match entry["type"].as_str()? {
            "builtin" | "platform" => {
                if object.contains_key("server") {
                    return None;
                }
                (
                    if entry["type"] == "builtin" {
                        "builtin"
                    } else {
                        "platform"
                    },
                    name(&entry["name"])?,
                    None,
                )
            }
            "mcp" => {
                if object.contains_key("name") {
                    return None;
                }
                let server = entry["server"].as_object()?;
                if server
                    .keys()
                    .any(|k| !["type", "name", "url", "headers"].contains(&k.as_str()))
                    || server.get("type")?.as_str()? != "http"
                    || !empty(server.get("headers"))
                {
                    return None;
                }
                let address = server.get("url")?.as_str()?;
                super::super::skill_management::mcp_http_url::validate(address).ok()?;
                let url = tauri::Url::parse(address).ok()?;
                // Only fixed public entry paths can be shown in full in this
                // slice. Other paths/queries may carry identity or secrets.
                // Never replace an unreviewable address with just its origin.
                if url.query().is_some() || !matches!(url.path(), "/" | "/mcp") {
                    return None;
                }
                ("http", name(server.get("name")?)?, Some(url.to_string()))
            }
            _ => return None,
        };
        items.push(Item {
            name: item_name,
            kind,
            address,
        });
    }
    Some(Configuration {
        complete: true,
        items,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn inventory(descriptor: Value) -> Inventory {
        Inventory::parse(json!({"extensions":[{"extensionKey":"owned","extension":descriptor}]}))
            .unwrap()
    }
    fn http() -> Value {
        json!({"type":"mcp","server":{"type":"http","name":"Owned","url":"http://127.0.0.1:8910/mcp","headers":[]}})
    }
    #[test]
    fn unreviewable_values_never_become_a_partial_public_configuration() {
        let cases = [
            (
                "/server/headers",
                json!([{"name":"Authorization","value":"PRIVATE"}]),
            ),
            ("/server/url", json!("http://127.0.0.1:8910/PRIVATE")),
            (
                "/server/url",
                json!("http://127.0.0.1:8910/mcp?token=PRIVATE"),
            ),
            ("/server/url", json!("http://PRIVATE@127.0.0.1:8910/mcp")),
            ("/server/url", json!("http://127.0.0.1:8910/mcp#PRIVATE")),
            ("/server/type", json!("sse")),
        ];
        for (path, value) in cases {
            let mut descriptor = http();
            *descriptor.pointer_mut(path).unwrap() = value;
            assert!(configuration(&inventory(descriptor)).is_none(), "{path}");
        }
        for (key, value) in [
            ("envKeys", json!(["PRIVATE"])),
            ("clientSecretKey", json!("PRIVATE")),
            ("available_tools", json!(["filtered"])),
            ("future", json!("PRIVATE")),
            ("name", json!("unexplained second name")),
            ("timeout", json!("invalid")),
        ] {
            let mut descriptor = http();
            descriptor[key] = value;
            assert!(configuration(&inventory(descriptor)).is_none(), "{key}");
        }
        let stdio =
            json!({"type":"mcp","server":{"name":"Owned","command":"fixture","args":[],"env":[]}});
        assert!(configuration(&inventory(stdio)).is_none());
        let mut unknown = http();
        unknown["server"]["future"] = json!("PRIVATE");
        assert!(configuration(&inventory(unknown)).is_none());
    }
    #[test]
    fn complete_limit_is_inclusive_and_never_truncates_or_exposes_private_metadata() {
        let mut values: Vec<_> = (0..LIMIT).map(|n| json!({
            "extensionKey":format!("key-{n}"),
            "extension":{"type":"platform","name":format!("Tool {n}"),"description":"PRIVATE metadata"}
        })).collect();
        let full = Inventory::parse(json!({"extensions":values})).unwrap();
        let public = serde_json::to_value(configuration(&full).unwrap()).unwrap();
        assert_eq!(public["items"].as_array().unwrap().len(), LIMIT);
        assert_eq!(public["complete"], true);
        assert!(!public.to_string().contains("PRIVATE"));
        values
            .push(json!({"extensionKey":"overflow","extension":{"type":"platform","name":"Last"}}));
        assert!(configuration(&Inventory::parse(json!({"extensions":values})).unwrap()).is_none());
        let empty = Inventory::parse(json!({"extensions":[]})).unwrap();
        assert!(configuration(&empty).unwrap().items.is_empty());
    }
}
