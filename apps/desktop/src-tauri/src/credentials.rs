use std::fmt;

use zeroize::Zeroizing;

/// Provider secrets, held by the operating system and nobody else.
///
/// A secret crosses from the webview into Rust exactly once, inside
/// `connect_provider`, and from that moment it lives in the operating system
/// credential store under an opaque connection id: Windows Credential Manager,
/// macOS Keychain, or the Linux Secret Service, whichever this machine has.
/// The only thing that ever travels back to the webview is a masked label.
///
/// There is no readback path by construction: `read_secret` is called from the
/// privileged network probes in `commands.rs` and no Tauri command returns its
/// result, so no sequence of webview calls can see a stored secret again.
/// Buffers this module controls are zeroized when dropped; the serialization
/// buffers the IPC layer used to carry the secret in are outside its reach and
/// that limit is stated here rather than papered over.
/// The service name every entry is filed under, matching the application
/// identifier in `tauri.conf.json`.
pub const CREDENTIAL_SERVICE: &str = "com.openlimiter.desktop";

/// Below this many characters nothing of a secret is ever shown.
pub const MASK_VISIBLE_MINIMUM_CHARS: usize = 20;

/// How many leading characters a long secret may show.
const MASK_PREFIX_CHARS: usize = 3;

/// How many trailing characters a long secret may show.
const MASK_SUFFIX_CHARS: usize = 4;

/// The fixed middle of every masked label. Always the same eight dots, so the
/// label never leaks the secret's length either.
pub(crate) const MASK_DOTS: &str = "········";

/// Longest a masked label can be, in characters: the visible edges plus the
/// eight fixed dots. Anything longer was not made by `mask_label`.
pub(crate) const MASK_LABEL_MAX_CHARS: usize =
    MASK_PREFIX_CHARS + MASK_SUFFIX_CHARS + MASK_DOTS_COUNT;

/// How many characters the fixed dots contribute.
const MASK_DOTS_COUNT: usize = 8;

/// The label a person sees in place of a secret.
///
/// At most the first three and last four characters are visible, and only when
/// the secret has at least twenty characters. Anything shorter masks
/// completely, because showing seven characters of a short secret is showing
/// most of it. The mask is built from characters, never bytes, so a multibyte
/// secret cannot be split mid character.
///
/// The secret is only ever iterated through the borrow: no intermediate
/// buffer of it is materialized, so no second plaintext copy can be left on a
/// freed heap. The only owned string here is the label itself, whose entire
/// content is deliberately public.
pub fn mask_label(secret: &str) -> String {
    let count = secret.chars().count();
    if count < MASK_VISIBLE_MINIMUM_CHARS {
        return MASK_DOTS.to_string();
    }
    let mut label = String::with_capacity(MASK_LABEL_MAX_CHARS * 4);
    label.extend(secret.chars().take(MASK_PREFIX_CHARS));
    label.push_str(MASK_DOTS);
    label.extend(secret.chars().skip(count - MASK_SUFFIX_CHARS));
    label
}

/// What went wrong at the credential store, with everything identifying
/// removed. No variant carries a payload, so no platform message, service
/// name, account, or secret can ride along.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialError {
    /// Nothing is stored under this connection.
    NotFound,
    /// The operating system credential store refused the operation.
    Store,
}

impl fmt::Display for CredentialError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let sentence = match self {
            CredentialError::NotFound => "no credential is stored for this connection",
            CredentialError::Store => "the system credential store refused the operation",
        };
        formatter.write_str(sentence)
    }
}

/// The three verbs the subsystem needs from a credential store. A trait so
/// tests inject an in memory double and never touch the machine's real store.
pub trait SecretStore: Send + Sync {
    fn store_secret(&self, connection_id: &str, secret: &str) -> Result<(), CredentialError>;
    fn read_secret(&self, connection_id: &str) -> Result<Zeroizing<String>, CredentialError>;
    fn delete_secret(&self, connection_id: &str) -> Result<(), CredentialError>;
}

/// The real store: the `keyring` crate over the operating system's own vault.
pub struct KeyringStore;

fn entry(connection_id: &str) -> Result<keyring::Entry, CredentialError> {
    keyring::Entry::new(CREDENTIAL_SERVICE, connection_id).map_err(|_| CredentialError::Store)
}

fn keyring_error(error: keyring::Error) -> CredentialError {
    match error {
        keyring::Error::NoEntry => CredentialError::NotFound,
        _ => CredentialError::Store,
    }
}

impl SecretStore for KeyringStore {
    fn store_secret(&self, connection_id: &str, secret: &str) -> Result<(), CredentialError> {
        entry(connection_id)?
            .set_password(secret)
            .map_err(keyring_error)
    }

    fn read_secret(&self, connection_id: &str) -> Result<Zeroizing<String>, CredentialError> {
        entry(connection_id)?
            .get_password()
            .map(Zeroizing::new)
            .map_err(keyring_error)
    }

    fn delete_secret(&self, connection_id: &str) -> Result<(), CredentialError> {
        entry(connection_id)?
            .delete_credential()
            .map_err(keyring_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_secret_masks_completely() {
        assert_eq!(mask_label(""), MASK_DOTS);
    }

    #[test]
    fn one_character_masks_completely() {
        assert_eq!(mask_label("k"), MASK_DOTS);
    }

    #[test]
    fn nineteen_characters_is_still_short() {
        let secret = "a".repeat(19);
        let masked = mask_label(&secret);
        assert_eq!(masked, MASK_DOTS);
        assert!(!masked.contains('a'));
    }

    #[test]
    fn twenty_characters_shows_three_and_four() {
        let masked = mask_label("abcdefghijklmnopqrst");
        assert_eq!(masked, format!("abc{MASK_DOTS}qrst"));
    }

    #[test]
    fn long_key_shows_only_the_edges() {
        let secret = "sk-or-v1-0123456789abcdef0123456789abcdef";
        let masked = mask_label(secret);
        assert_eq!(masked, format!("sk-{MASK_DOTS}cdef"));
        /* The middle of the secret must be gone entirely. */
        assert!(!masked.contains("0123456789"));
    }

    #[test]
    fn short_secret_leaks_no_length() {
        assert_eq!(mask_label("ab"), mask_label("abcdefghijklmnopqrs"));
    }

    #[test]
    fn multibyte_secret_masks_on_character_boundaries() {
        let secret = "ключключключключключ";
        assert_eq!(secret.chars().count(), 20);
        let masked = mask_label(secret);
        assert_eq!(masked, format!("клю{MASK_DOTS}ключ"));
    }

    #[test]
    fn mask_label_materializes_no_copy_of_the_secret() {
        /* Heap state cannot be asserted at runtime, so the structure is
        pinned instead: the masking body may only iterate the borrowed str.
        Collecting the secret into any owned buffer would leave an unzeroized
        plaintext copy behind, so `collect` and `Vec<char>` are banned from
        this module outright, and the streaming appends must be present. */
        let source = include_str!("credentials.rs");
        let head = source
            .split("mod tests")
            .next()
            .expect("the module has a body before its tests");
        assert!(!head.contains("collect"));
        assert!(!head.contains("Vec<char>"));
        assert!(!head.contains("to_owned"));
        assert!(head.contains("label.extend(secret.chars().take("));
        assert!(head.contains("label.extend(secret.chars().skip("));
    }

    #[test]
    fn credential_error_sentences_are_fixed() {
        assert_eq!(
            CredentialError::NotFound.to_string(),
            "no credential is stored for this connection"
        );
        assert_eq!(
            CredentialError::Store.to_string(),
            "the system credential store refused the operation"
        );
    }
}
