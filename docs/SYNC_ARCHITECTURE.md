# OpenLimiter encrypted synchronisation specification

## 1. Threat model

### Security goals

1. The desktop is the authoritative quota producer.

2. Phones are read only viewers. They cannot change quota state, configure the desktop, execute actions, or request provider credentials.

3. Each phone receives a separately encrypted copy. Compromise of one phone does not expose another phone.

4. The relay provides routing, temporary storage, and wake signals only.

### Adversaries

1. Compromised relay or operator

   Can inspect IP addresses, connection times, message frequency, padded sizes, random routing identifiers, device count, subscription status, and push destination type.

   Can copy, replay, reorder, delay, delete, or refuse messages. It can send false wake notifications.

   Cannot decrypt quota state, learn provider identity from payloads, forge a valid desktop update, enroll a decrypting device, or derive keys from a recorded pairing exchange.

2. Network observer

   Can see connections to the relay, traffic volume, timing, and approximate duration.

   Cannot read relay traffic because every connection uses TLS 1.3. Even if TLS is later defeated at the relay, message content remains end to end encrypted.

3. Malicious paired phone

   Can read and disclose everything legitimately sent to that phone.

   Cannot read another device’s stream, forge desktop signed state, authorize another device, modify desktop state, or invoke desktop commands. It can spam its own relay route.

4. Lost or stolen phone

   A locked phone protects keys through the platform credential store and device lock.

   An unlocked phone exposes its local quota cache and its own pair keys. Revocation prevents future delivery but cannot erase information already received. Remote wipe is best effort only.

5. Compromised desktop

   This is a total compromise. Malware running as the user can read live quota data, forge alerts, steal active pair keys, and possibly authorize devices.

   Requiring explicit operating system authentication for pairing and authority operations reduces unattended abuse but does not defeat full endpoint compromise.

### Explicit exclusions

The design does not defend against denial of service, traffic analysis, malicious operating systems, compromised build or update infrastructure, physical coercion, screenshots, careless confirmation of mismatched pairing codes, inaccurate provider data, or plaintext deliberately shown on a lock screen.

## 2. Key management

### Keys

1. Account Authority Key

   One Ed25519 signing key generated on the first desktop. It signs device grants, revocations, and authority rotation records.

   It is never used to encrypt quota data and is not needed during ordinary background synchronisation.

2. Device identity keys

   Every device generates one X25519 static key for Noise pairing and one Ed25519 signing key for signed protocol records.

3. Pair keys

   Every desktop and phone pair receives an independent 256 bit channel secret from the completed Noise handshake. HKDF derives separate encryption keys for each direction and key epoch.

4. Device Storage Key

   Every installation generates a random 256 bit local wrapping key. Private keys, pair keys, relay tokens, and the local synchronisation cache are encrypted under it.

5. Pairing secret

   A random 256 bit, five minute, single use secret. It exists only in desktop memory and the QR or pairing link.

6. Recovery secret

   A random 256 bit value encoded as a printable Base58Check recovery code. HKDF derives a key that encrypts the Account Authority Key backup. It is never generated from an account password.

All randomness must come from the operating system cryptographic random generator.

### Platform storage

1. Windows

   Store the Device Storage Key as a Windows Credential Manager generic credential, protected by user scoped DPAPI. Store encrypted key records under `%LOCALAPPDATA%\OpenLimiter` with an ACL limited to the user and SYSTEM.

   Protect Account Authority Key use with Windows Hello confirmation where available. Never use machine scoped DPAPI.

2. macOS

   Store the Device Storage Key in Keychain Services with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. Restrict its access group to OpenLimiter.

   Store the Account Authority Key separately with an access control requiring user presence for pairing, revocation, or rotation.

3. Linux

   Use the Secret Service API, normally backed by GNOME Keyring or KWallet.

   If no Secret Service is available, require a user passphrase at synchronisation startup. Derive a wrapping key with Argon2id using calibrated parameters of at least 64 MiB, three passes, and parallelism one. Store only the encrypted blob with mode `0600`. There must be no plaintext fallback.

4. iOS

   Store the Device Storage Key in Keychain with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. Use an access group limited to the app and its notification extension.

   Exclude all key material and decrypted cache data from iCloud backup. Default phones do not receive the Account Authority Key.

5. Android

   Generate a nonexportable AES 256 wrapping key in Android Keystore. Prefer hardware backing and StrongBox when available. Require an unlocked device for access.

   Store encrypted key records only in internal application storage. Disable Android Auto Backup for keys and decrypted synchronisation data.

Exact X25519 and Ed25519 private values may require application level wrapping because Secure Enclave and Keystore support for those curves is inconsistent. Use an audited cryptographic library compiled into the application.

## 3. Pairing

QR pairing is the preferred method.

### QR contents

Encode canonical CBOR containing:

1. Protocol version.

2. Approved relay origin identifier.

3. Random 128 bit offer identifier.

4. Random desktop routing identifier.

5. Desktop X25519 public key.

6. Desktop Ed25519 public key.

7. Account Authority public key.

8. Desktop device certificate.

9. Random 256 bit pairing secret.

10. Creation and expiry times.

11. Desktop display label.

12. Ed25519 signature by the desktop over every preceding field.

The QR contains no account email, provider identity, quota value, provider token, or relay bearer token.

### Handshake

1. The desktop creates a five minute relay offer containing only the offer identifier, routing information, and expiry. The pairing secret is never uploaded.

2. The phone scans the QR, validates its structure, expiry, relay origin, desktop signature, and authority certificate.

3. The phone generates its device identity keys locally.

4. The phone and desktop exchange Noise `IKpsk2` messages through the relay using X25519, ChaCha20 Poly1305, and SHA 256. The phone pins the desktop static key from the QR. The pairing secret is the Noise preshared key.

5. Noise authenticates possession of both X25519 private keys and knowledge of the pairing secret. Passive relay observation cannot derive the resulting channel key.

6. Inside the encrypted channel, the phone sends its Ed25519 public key, requested viewer role, random routing identifier, device name, platform, and a signature binding these values to the Noise transcript.

7. Both devices calculate a four word short authentication string from the first 44 bits of a domain separated SHA 256 hash of the complete transcript.

8. The desktop displays the phone name, platform, and four words. The phone displays the desktop name and the same four words.

9. The user compares the displays and confirms on both devices. No device is enrolled before both confirmations arrive.

10. The desktop signs a viewer device grant with the Account Authority Key and sends it inside the encrypted channel.

11. The desktop activates the phone’s random relay route and transfers a scoped relay token through the encrypted channel.

12. Both devices derive pair keys with HKDF, persist only the required keys, erase Noise ephemeral keys and the pairing secret, and mark the offer consumed.

The relay permits at most three handshake attempts per offer. An offer becomes unusable after successful pairing, explicit cancellation, or five minutes.

A pairing link may carry the same CBOR in a URL fragment, never in the host, path, or query. QR pairing remains safer because messaging applications and operating systems may retain links.

## 4. Transport and relay

A relay is required for reliable use across networks, offline desktop access to the last uploaded state, and mobile wake notifications. A direct local network path cannot provide these properties.

A later free local network mode may use direct connections, but it is an optional transport for the same encrypted protocol. It should not be in the first release because discovery and inbound listeners add attack surface.

All clients use outbound TLS 1.3 HTTPS or WebSocket connections. End to end security does not depend on TLS termination remaining honest.

### Envelope

The visible envelope contains:

1. Protocol version.

2. Random sender and recipient routing identifiers.

3. Random pair identifier.

4. Key epoch.

5. Random 128 bit message identifier.

6. Random 192 bit XChaCha nonce.

7. Expiry time.

8. Padded ciphertext.

The encrypted record contains:

1. Schema version and message type.

2. Sender sequence number.

3. Previous accepted record digest.

4. Creation and observation times.

5. Full self contained quota snapshot or alert.

6. Sender device certificate.

7. Ed25519 signature over the canonical record and relevant outer routing fields.

Use canonical CBOR. Pad records inside encryption to fixed buckets such as 4 KiB, 16 KiB, and 64 KiB.

### Replay and ordering

1. Sequence numbers are monotonic for each producer and pair.

2. Recipients persist the highest accepted sequence in protected local storage.

3. Duplicate message identifiers and sequence numbers at or below the accepted value are rejected.

4. A gap is reported and missing records are requested. A newer, valid, signed, self contained snapshot may be accepted after a gap because current quota state matters more than complete history.

5. Reinstallation destroys device local keys. The device must pair again under a new pair identifier, so old relay messages cannot be replayed into it.

### Offline behaviour

The relay stores encrypted envelopes until acknowledgement or expiry.

When the desktop is offline, the phone can read the last signed snapshot and queued alerts. It must show the desktop observation time and a prominent stale status. The relay never polls AI providers and never invents a fresh quota value.

Version one has one authoritative desktop producer and any number of viewer phones. Later desktops should publish independent signed streams. Do not introduce shared writable state or automatic conflict merging.

## 5. Cryptography choices

1. Noise `IKpsk2`

   Provides an established authenticated handshake where the phone already knows the desktop static public key. The additional high entropy secret binds the session to the physical QR.

2. X25519

   Widely reviewed, efficient, and supported by mature libraries.

3. Ed25519

   Used for durable device certificates, snapshots, grants, revocations, and audit records. Signatures prevent a malicious relay or paired viewer from impersonating the desktop.

4. HKDF SHA 256

   Derives pair, direction, epoch, recovery, and confirmation keys using distinct domain labels.

5. XChaCha20 Poly1305

   Used for message and local record encryption. Its 192 bit nonce makes randomly generated nonces practical and safer for a solo implementation than AES GCM nonce management.

6. SHA 256

   Used for transcript hashes, previous record digests, and identifiers where a keyed construction is unnecessary.

Use a mature Noise implementation and a mature XChaCha and Ed25519 implementation. Statically linking an audited library preserves the no runtime dependency property.

Never invent a key exchange, modify a Noise pattern, implement elliptic curve arithmetic, reuse an AEAD nonce, use raw ECDH output as a key, encrypt without authentication, derive recovery from an ordinary password, log secrets, or allow the server to generate device keys.

## 6. Revocation and recovery

### Revocation

1. The authority desktop signs a revocation naming the device certificate and effective sequence.

2. The relay disables that device’s token, deletes its queued envelopes, and rejects future delivery.

3. Every producer deletes the revoked pair key and stops producing ciphertext for that device.

4. Other pair keys do not require rotation because every phone has an independent key.

Revocation cannot erase local data or keys already copied by the revoked device.

### Rotation

1. Rotate pair keys through a fresh authenticated Noise exchange, at least annually and after suspected exposure.

2. Keep the old epoch only until the new epoch is acknowledged or seven days pass.

3. Rotate a device identity by issuing a new authority signed certificate and revoking the old certificate.

4. If the desktop or Account Authority Key might be compromised, rotate the authority and reestablish every pair. Merely changing the relay password is insufficient.

### Recovery

The client encrypts the Account Authority private seed using a key derived from the recovery secret and uploads only the encrypted recovery bundle. The bundle is authenticated with the authority public key and format version as associated data.

Account login recovery restores billing access only. It never enrolls a decrypting device.

A replacement desktop can recover authority using the recovery code, revoke missing devices, and create new pairs. It cannot decrypt old phone specific ciphertext.

If both every authority device and the recovery code are lost, encrypted identity recovery is impossible. The operator may create a new empty cryptographic namespace after account verification and a cooling period. Old ciphertext is deleted, not decrypted.

## 7. Push notifications

1. Every mailbox update may trigger the same generic APNs or FCM wake request.

2. The push payload contains only an opaque device token, protocol version, random mailbox generation value, and optionally a fixed size encrypted record.

3. It never contains provider identity, quota value, threshold, plan name, account identity, or readable alert text.

4. After wake, the phone fetches, verifies, and decrypts the envelope. The application then creates the detailed notification locally.

5. On iOS, a Notification Service Extension may decrypt the fixed size encrypted payload and replace a generic placeholder. If keys are unavailable while locked, the placeholder remains generic until unlock.

6. On Android, a high priority data message wakes the application, which decrypts before posting the notification. Delivery restrictions may delay it.

Apple and Google still learn that OpenLimiter sent a notification to a particular push token at a particular time. This metadata cannot be hidden while using their push services.

## 8. What the server may store

### Permitted

1. Billing account identifier and subscription status.

2. Payment processor customer and subscription references.

3. Passkey public credentials, hashed authentication tokens, and necessary account recovery metadata.

4. Account Authority public key.

5. Random relay namespace, offer, route, pair, and mailbox identifiers.

6. Push tokens.

7. Offer expiry and consumption state.

8. Opaque Noise handshake frames for at most ten minutes.

9. Encrypted, padded message envelopes.

10. Acknowledgement cursors, expiry times, and rate limit counters.

11. Encrypted authority recovery bundle.

12. Minimal security logs containing IP address, time, route identifier, and outcome.

### Forbidden

1. Plaintext provider identity or quota state.

2. Provider API keys, cookies, OAuth tokens, or subscription credentials.

3. Device private keys, pair keys, pairing secrets, or recovery secrets.

4. Decrypted messages or notification text.

5. Screenshots, command history, prompts, source code, or arbitrary desktop data.

6. Analytics payloads derived from encrypted message content.

7. Secret values in logs, crash reports, support tools, or traces.

### Retention

1. Pairing frames: ten minutes maximum.

2. Encrypted envelopes: until acknowledgement or seven days, whichever occurs first.

3. Operational metadata and IP logs: seven days.

4. Security abuse records: thirty days where necessary.

5. Push tokens and routes: deleted immediately on revocation or account deletion.

6. Account deletion: active data removed within twenty four hours. Encrypted backups expire within thirty days. Statutory payment records remain isolated for the legally required period.

Managed authentication and Stripe Billing can replace custom identity and payment systems. A managed database and queue can replace custom relay persistence. The tradeoff is additional vendors seeing account and traffic metadata. None may receive plaintext or client keys.

## 9. Build order

1. Freeze the protocol and obtain an external cryptography review.

2. Build one desktop producer, one phone viewer, QR pairing only, foreground refresh, signed self contained snapshots, seven day relay retention, and no push.

3. Add revocation, authority recovery, deletion, protocol test vectors, parser fuzzing, and simulated malicious relay tests.

4. Add generic push wake messages. Add local detailed notifications only after mobile key access has been tested while locked, unlocked, terminated, and offline.

5. Port the identical protocol to every desktop and mobile platform. Do not create platform specific cryptographic variants.

6. Add multiple independent desktop streams.

7. Add optional direct local network transport only after the relay design is stable.

The hardest parts are pairing state transitions, transcript binding, authority recovery, platform key storage, and mobile background execution. Fatal mistakes include nonce reuse, logging QR or recovery secrets, accepting unsigned or older snapshots, allowing account recovery to enroll a device, or trusting the relay to decide cryptographic membership.

## 10. Honest risks

1. Endpoint compromise remains decisive.

2. The relay, network providers, Apple, and Google can infer usage patterns from timing.

3. A user may approve the wrong pairing phrase.

4. Platform credential stores differ and may behave unexpectedly during backup, migration, lock, biometric changes, or application reinstall.

5. Push delivery is not guaranteed and quota information can become stale.

6. Library misuse, canonical encoding differences, integer overflow, parser bugs, and unsafe logging can defeat sound primitives.

7. The desktop update channel is part of the trust boundary. A malicious signed release can steal every local secret.

Before real users rely on the service, independent reviewers should examine the Noise integration, transcript and certificate binding, envelope encryption, sequence handling, recovery construction, pairing interface, platform storage, notification extensions, relay tenant isolation, deletion implementation, dependency supply chain, and signed update process. A cryptography review and separate mobile security review are mandatory.
