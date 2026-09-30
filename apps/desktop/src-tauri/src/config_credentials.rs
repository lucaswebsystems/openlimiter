//! Credentials in a client's configuration, read only once the vendor is proven.
//!
//! Some coding clients keep a vendor's key in their own settings: the Claude
//! Code settings file that points `ANTHROPIC_BASE_URL` at Z.ai, MiniMax or
//! Synthetic and carries that vendor's key beside it, or Cline's provider
//! settings. The research documents those fields as credentials, so they are an
//! acquisition source. The same file, pointed anywhere else, holds somebody's
//! Anthropic credential, and sending that to Z.ai would be the exact confused
//! deputy the routing table exists to prevent.
//!
//! So a documented credential field is read only AFTER the configuration
//! proves the vendor: its configured endpoint is https on one of the vendor's
//! own hosts, or its documented provider selector names the vendor and no
//! endpoint override points elsewhere. Nothing else in the file is read, and
//! every file without a matching rule stays what detection always treated it
//! as: a presence marker. The per provider rules are written by each provider's
//! lane in its own module; this file is the one mechanism they share.
//!
//! The key never leaves this module except inside `Zeroizing`, and no error
//! says anything about the file. The account identity of what it returns is the
//! key's fingerprint (see `account_identity.rs`), never the key.

use std::path::Path;

use serde_json::Value;
use zeroize::Zeroizing;

use crate::fsx;

/// Largest credential accepted, the same bound every key shaped secret has.
const MAX_CONFIG_SECRET_BYTES: usize = crate::reader_registry::MAX_KEY_SECRET_BYTES;

/// Longest account identifier believed, the bound detection applies to every identity.
const MAX_IDENTITY_BYTES: usize = 512;

/// Longest endpoint text inspected. A configured base URL is short.
const MAX_ENDPOINT_BYTES: usize = 2_048;

/// How a configuration proves that its credential belongs to one vendor.
/// Built by the lanes' footprint rules; until one ships, only tests build it.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum VendorProof {
    /// The configured endpoint field is an https URL on exactly one of these
    /// hosts. No suffix match, no other scheme, no user information, no port
    /// but the default.
    Endpoint {
        field: &'static str,
        hosts: &'static [&'static str],
    },
    /// The documented provider selector equals `value` exactly, and the
    /// optional endpoint override, when the file states one, is https on one of
    /// `hosts`. For a client that selects a vendor by name rather than by URL.
    Selector {
        field: &'static str,
        value: &'static str,
        override_field: Option<&'static str>,
        hosts: &'static [&'static str],
    },
}

/// One documented credential field inside one client configuration shape.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ConfigCredentialRule {
    /// Object keys from the document root to the object holding the fields.
    /// Empty means the root object itself.
    pub container: &'static [&'static str],
    pub proof: VendorProof,
    /// The documented credential field, read only after the proof holds.
    pub credential_field: &'static str,
    /// The documented field naming the account, for a token route. A token is
    /// never its own identity, because the vendor rotates it.
    pub account_field: Option<&'static str>,
}

/// A vendor credential read out of a client configuration.
pub(crate) struct ConfigCredential {
    pub secret: Zeroizing<String>,
    /// The account the configuration names, when its rule has an account field
    /// and the value is a believable identity.
    pub account: Option<String>,
}

impl std::fmt::Debug for ConfigCredential {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ConfigCredential(redacted)")
    }
}

/// Whether `endpoint` is https on exactly one of `hosts`.
///
/// A strict reading of the only shape a configured base URL takes, written out
/// rather than delegated, because the question is narrow and a permissive URL
/// parser is the wrong tool for a check whose failure sends a credential to the
/// wrong vendor: `https://api.z.ai.attacker.example`, `https://api.z.ai@x.example`
/// and `https://api.z.ai:8443` must all be refused.
pub(crate) fn endpoint_belongs_to(endpoint: &str, hosts: &[&str]) -> bool {
    if endpoint.len() > MAX_ENDPOINT_BYTES || endpoint.chars().any(char::is_control) {
        return false;
    }
    let Some(rest) = endpoint.trim().strip_prefix("https://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') || authority.contains('\\') {
        return false;
    }
    let host = match authority.rsplit_once(':') {
        Some((host, "443")) => host,
        Some(_) => return false,
        None => authority,
    };
    let host = host.strip_suffix('.').unwrap_or(host);
    hosts
        .iter()
        .any(|allowed| host.eq_ignore_ascii_case(allowed))
}

fn container<'a>(root: &'a Value, path: &[&str]) -> Option<&'a serde_json::Map<String, Value>> {
    let mut current = root;
    for key in path {
        current = current.as_object()?.get(*key)?;
    }
    current.as_object()
}

fn text_field<'a>(object: &'a serde_json::Map<String, Value>, field: &str) -> Option<&'a str> {
    object.get(field)?.as_str()
}

fn proven(object: &serde_json::Map<String, Value>, proof: VendorProof) -> bool {
    match proof {
        VendorProof::Endpoint { field, hosts } => {
            text_field(object, field).is_some_and(|endpoint| endpoint_belongs_to(endpoint, hosts))
        }
        VendorProof::Selector {
            field,
            value,
            override_field,
            hosts,
        } => {
            text_field(object, field) == Some(value)
                && override_field.is_none_or(|name| match object.get(name) {
                    None | Some(Value::Null) => true,
                    Some(Value::String(endpoint)) => endpoint_belongs_to(endpoint, hosts),
                    Some(_) => false,
                })
        }
    }
}

fn valid_identity(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_IDENTITY_BYTES && !value.chars().any(char::is_control)
}

fn valid_secret(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_CONFIG_SECRET_BYTES && !value.chars().any(char::is_control)
}

/// Read one configuration and return the vendor credential, or nothing.
///
/// Nothing is the answer for a missing, oversized, linked or malformed file, a
/// missing container, a proof that does not hold, and a credential field that
/// is absent, empty, oversized or carries control characters. The file is read
/// through the same bounded, link refusing read every state file uses.
pub(crate) fn read_config_credential(
    path: &Path,
    rule: &ConfigCredentialRule,
) -> Option<ConfigCredential> {
    let raw = Zeroizing::new(fsx::bounded_read(path)?);
    let root: Value = serde_json::from_str(&raw).ok()?;
    let object = container(&root, rule.container)?;
    if !proven(object, rule.proof) {
        return None;
    }
    let secret = text_field(object, rule.credential_field)?.trim();
    let account = rule
        .account_field
        .and_then(|field| text_field(object, field))
        .map(str::trim)
        .filter(|value| valid_identity(value))
        .map(str::to_string);
    valid_secret(secret).then(|| ConfigCredential {
        secret: Zeroizing::new(secret.to_string()),
        account,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    /// A fixture shape: the Claude Code settings file pointed at a vendor.
    const ENDPOINT_RULE: ConfigCredentialRule = ConfigCredentialRule {
        container: &["env"],
        proof: VendorProof::Endpoint {
            field: "ANTHROPIC_BASE_URL",
            hosts: &["api.vendor.example"],
        },
        credential_field: "ANTHROPIC_AUTH_TOKEN",
        account_field: None,
    };

    /// A fixture shape: a client that selects a vendor by name.
    const SELECTOR_RULE: ConfigCredentialRule = ConfigCredentialRule {
        container: &["providers", "vendor"],
        proof: VendorProof::Selector {
            field: "provider",
            value: "vendor",
            override_field: Some("baseUrl"),
            hosts: &["api.vendor.example"],
        },
        credential_field: "token",
        account_field: Some("accountId"),
    };

    fn settings(dir: &TempDir, text: &str) -> std::path::PathBuf {
        let path = dir.path().join("settings.json");
        std::fs::write(&path, text).expect("fixture");
        path
    }

    fn read(text: &str, rule: &ConfigCredentialRule) -> Option<String> {
        let dir = TempDir::new();
        let path = settings(&dir, text);
        read_config_credential(&path, rule).map(|found| found.secret.to_string())
    }

    #[test]
    fn a_vendor_endpoint_proves_the_credential_beside_it() {
        let text = r#"{"env":{"ANTHROPIC_BASE_URL":"https://api.vendor.example/api/anthropic","ANTHROPIC_AUTH_TOKEN":"fixture-vendor-key"}}"#;
        assert_eq!(read(text, &ENDPOINT_RULE).as_deref(), Some("fixture-vendor-key"));
        let with_port = r#"{"env":{"ANTHROPIC_BASE_URL":"https://API.VENDOR.EXAMPLE:443","ANTHROPIC_AUTH_TOKEN":" fixture-vendor-key "}}"#;
        assert_eq!(read(with_port, &ENDPOINT_RULE).as_deref(), Some("fixture-vendor-key"));
    }

    #[test]
    fn any_other_endpoint_leaves_the_file_a_presence_marker() {
        for endpoint in [
            "https://api.anthropic.com",
            "http://api.vendor.example",
            "https://api.vendor.example.attacker.example",
            "https://attacker.example/api.vendor.example",
            "https://api.vendor.example@attacker.example",
            "https://user@api.vendor.example",
            "https://api.vendor.example:8443",
            "https://api.vendor.example\\@attacker.example",
            "api.vendor.example",
            "",
        ] {
            let text = serde_json::json!({
                "env": { "ANTHROPIC_BASE_URL": endpoint, "ANTHROPIC_AUTH_TOKEN": "fixture-anthropic-token" }
            })
            .to_string();
            assert_eq!(read(&text, &ENDPOINT_RULE), None, "{endpoint}");
        }
        /* No endpoint at all is the plain Anthropic setup: never a vendor key. */
        let plain = r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"fixture-anthropic-token"}}"#;
        assert_eq!(read(plain, &ENDPOINT_RULE), None);
        let number = r#"{"env":{"ANTHROPIC_BASE_URL":443,"ANTHROPIC_AUTH_TOKEN":"fixture-anthropic-token"}}"#;
        assert_eq!(read(number, &ENDPOINT_RULE), None);
    }

    #[test]
    fn a_bad_credential_or_shape_yields_nothing() {
        let long = "k".repeat(MAX_CONFIG_SECRET_BYTES + 1);
        for text in [
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://api.vendor.example"}}"#.to_string(),
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://api.vendor.example","ANTHROPIC_AUTH_TOKEN":""}}"#.to_string(),
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://api.vendor.example","ANTHROPIC_AUTH_TOKEN":"a\u0007b"}}"#.to_string(),
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://api.vendor.example","ANTHROPIC_AUTH_TOKEN":7}}"#.to_string(),
            format!(r#"{{"env":{{"ANTHROPIC_BASE_URL":"https://api.vendor.example","ANTHROPIC_AUTH_TOKEN":"{long}"}}}}"#),
            r#"{"ANTHROPIC_BASE_URL":"https://api.vendor.example","ANTHROPIC_AUTH_TOKEN":"root-level"}"#.to_string(),
            r#"{"env":["not","an","object"]}"#.to_string(),
            "not json".to_string(),
        ] {
            assert_eq!(read(&text, &ENDPOINT_RULE), None, "{text}");
        }
    }

    #[test]
    fn a_selector_proves_the_vendor_unless_an_override_points_elsewhere() {
        let named = r#"{"providers":{"vendor":{"provider":"vendor","token":"fixture-account-token"}}}"#;
        assert_eq!(read(named, &SELECTOR_RULE).as_deref(), Some("fixture-account-token"));
        let own_override = r#"{"providers":{"vendor":{"provider":"vendor","baseUrl":"https://api.vendor.example/v1","token":"fixture-account-token"}}}"#;
        assert_eq!(read(own_override, &SELECTOR_RULE).as_deref(), Some("fixture-account-token"));
        for text in [
            r#"{"providers":{"vendor":{"provider":"other","token":"fixture-account-token"}}}"#,
            r#"{"providers":{"vendor":{"provider":"Vendor","token":"fixture-account-token"}}}"#,
            r#"{"providers":{"vendor":{"provider":"vendor","baseUrl":"https://proxy.example","token":"fixture-account-token"}}}"#,
            r#"{"providers":{"vendor":{"provider":"vendor","baseUrl":7,"token":"fixture-account-token"}}}"#,
            r#"{"providers":{"vendor":{"token":"fixture-account-token"}}}"#,
        ] {
            assert_eq!(read(text, &SELECTOR_RULE), None, "{text}");
        }
    }

    #[test]
    fn a_token_route_names_its_account_from_the_documented_field_only() {
        let dir = TempDir::new();
        let account = |text: &str| {
            read_config_credential(&settings(&dir, text), &SELECTOR_RULE)
                .expect("a proven credential")
                .account
        };
        assert_eq!(
            account(r#"{"providers":{"vendor":{"provider":"vendor","token":"fixture-account-token","accountId":" fixture-account "}}}"#).as_deref(),
            Some("fixture-account")
        );
        for unbelievable in [r#""""#, r#""a\u0007b""#, "7"] {
            let text = format!(
                r#"{{"providers":{{"vendor":{{"provider":"vendor","token":"fixture-account-token","accountId":{unbelievable}}}}}}}"#
            );
            assert_eq!(account(&text), None, "{text}");
        }
        /* A rule without an account field never names one. */
        let path = settings(
            &dir,
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://api.vendor.example","ANTHROPIC_AUTH_TOKEN":"fixture-vendor-key","accountId":"fixture-account"}}"#,
        );
        assert_eq!(
            read_config_credential(&path, &ENDPOINT_RULE)
                .expect("a proven credential")
                .account,
            None
        );
    }

    #[test]
    fn a_missing_file_yields_nothing_and_a_found_key_prints_as_redacted() {
        let dir = TempDir::new();
        assert!(read_config_credential(&dir.path().join("absent.json"), &ENDPOINT_RULE).is_none());
        let found = read_config_credential(
            &settings(
                &dir,
                r#"{"env":{"ANTHROPIC_BASE_URL":"https://api.vendor.example","ANTHROPIC_AUTH_TOKEN":"fixture-vendor-key"}}"#,
            ),
            &ENDPOINT_RULE,
        )
        .expect("a proven credential");
        assert_eq!(format!("{found:?}"), "ConfigCredential(redacted)");
    }
}
