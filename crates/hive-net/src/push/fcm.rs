//! Google's push service, Firebase Cloud Messaging (design §12.4, spec/push.md 0.3 "Passed on"): a
//! data message the phone's app decrypts and makes the notification of, sent with an access token
//! this server's service account is given for an assertion it signs.

use anyhow::{Context, Result};
use ring::signature::RsaKeyPair;
use serde_json::{json, Value};

use super::{answer_of, wire::Urgency, Outgoing, Passed};
use crate::jwt;

/// The largest data a message carries, its key and value together.
const MAX_DATA: usize = 4096;

/// Google's push service, with this server's service account.
pub struct Fcm {
    key: RsaKeyPair,
    email: String,
    token_uri: String,
    project: String,
    /// The access token last given, and until when (s).
    access: tokio::sync::Mutex<Option<(String, u64)>>,
}

impl Fcm {
    /// From a service account's key file, as Google gives it.
    pub fn new(service_account: &str) -> Result<Self> {
        let account: Value =
            serde_json::from_str(service_account).context("the FCM service account is not JSON")?;
        let field = |name: &str| -> Result<String> {
            Ok(account[name]
                .as_str()
                .with_context(|| format!("the FCM service account has no {name}"))?
                .to_string())
        };
        let key = RsaKeyPair::from_pkcs8(&jwt::pem_der(&field("private_key")?)?)
            .map_err(|e| anyhow::anyhow!("the FCM service account's key is not an RSA key: {e}"))?;
        Ok(Self {
            key,
            email: field("client_email")?,
            token_uri: field("token_uri")?,
            project: field("project_id")?,
            access: tokio::sync::Mutex::new(None),
        })
    }

    /// The signed assertion the service account exchanges for an access token, at `now` (s).
    fn assertion(&self, now: u64) -> Result<String> {
        jwt::rs256(
            &self.key,
            &json!({ "alg": "RS256", "typ": "JWT" }),
            &json!({
                "iss": self.email,
                "scope": "https://www.googleapis.com/auth/firebase.messaging",
                "aud": self.token_uri,
                "iat": now,
                "exp": now + 3600,
            }),
        )
    }

    /// An access token at `now` (s): the one Google gave, until five minutes before it expires.
    pub(crate) async fn bearer(&self, http: &reqwest::Client, now: u64) -> Result<String> {
        let mut kept = self.access.lock().await;
        if let Some((token, until)) = kept.as_ref() {
            if now + 300 < *until {
                return Ok(token.clone());
            }
        }
        let form = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer")
            .append_pair("assertion", &self.assertion(now)?)
            .finish();
        let response = http
            .post(&self.token_uri)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(form)
            .send()
            .await?
            .error_for_status()
            .context("Google refused the service account")?;
        let answer: Value = serde_json::from_str(&answer_of(response).await)?;
        let token = answer["access_token"]
            .as_str()
            .context("Google gave no access token")?
            .to_string();
        let lasts = answer["expires_in"].as_u64().unwrap_or(3600);
        *kept = Some((token.clone(), now + lasts));
        Ok(token)
    }

    /// Google's answer was that the access token is no longer good: the next request gets another.
    pub(crate) async fn forget_access(&self, status: u16) {
        if status == 401 {
            *self.access.lock().await = None;
        }
    }

    /// The message that tells the phone of registration token `token` the notice in `data`.
    pub(crate) fn request(
        &self,
        token: &str,
        data: String,
        ttl: u64,
        urgency: Urgency,
        bearer: &str,
    ) -> Outgoing {
        let priority = if urgency == Urgency::High {
            "HIGH"
        } else {
            "NORMAL"
        };
        let message = json!({ "message": {
            "token": token,
            "data": { "m": data },
            "android": { "priority": priority, "ttl": format!("{ttl}s") },
        } });
        Outgoing {
            url: format!(
                "https://fcm.googleapis.com/v1/projects/{}/messages:send",
                self.project
            ),
            headers: vec![
                ("authorization", format!("Bearer {bearer}")),
                ("content-type", "application/json".into()),
            ],
            body: message.to_string().into_bytes(),
        }
    }
}

/// The notice `body`, as the data a message carries; none when it is too large for Google.
pub(crate) fn data(body: &[u8]) -> Option<String> {
    let m = jwt::b64url(body);
    ("m".len() + m.len() <= MAX_DATA).then_some(m)
}

/// What Google's answer says of the phone: one whose token it no longer knows (`UNREGISTERED`, as
/// Google says it, not any 404, which a proxy might answer for a server misconfigured).
pub(crate) fn passed(status: u16, answer: &str) -> Passed {
    let unregistered = serde_json::from_str::<Value>(answer)
        .ok()
        .and_then(|v| v["error"]["details"].as_array().cloned())
        .is_some_and(|details| details.iter().any(|d| d["errorCode"] == "UNREGISTERED"));
    match status {
        200 => Passed::Delivered,
        400 | 404 if unregistered => Passed::Gone,
        _ => Passed::Failed(format!("FCM answered {status}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{UnparsedPublicKey, RSA_PKCS1_2048_8192_SHA256};

    /// A service account's key file, as Google gives one, with a new RSA key (`openssl`: ring
    /// makes none), and that key's public half.
    fn service_account() -> (String, Vec<u8>) {
        let made = std::process::Command::new("openssl")
            .args([
                "genpkey",
                "-algorithm",
                "RSA",
                "-pkeyopt",
                "rsa_keygen_bits:2048",
            ])
            .output()
            .expect("openssl makes an RSA key");
        assert!(made.status.success());
        let key = String::from_utf8(made.stdout).unwrap();
        let public = RsaKeyPair::from_pkcs8(&jwt::pem_der(&key).unwrap())
            .unwrap()
            .public()
            .as_ref()
            .to_vec();
        let account = json!({
            "type": "service_account",
            "project_id": "hive-test",
            "private_key": key,
            "client_email": "push@hive-test.iam.gserviceaccount.com",
            "token_uri": "https://oauth2.googleapis.com/token",
        });
        (account.to_string(), public)
    }

    fn header(out: &Outgoing, name: &str) -> Option<String> {
        out.headers
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| v.clone())
    }

    #[test]
    fn google_is_sent_a_data_message_the_phone_decrypts_by_a_service_account_that_proves_its_key() {
        let (account, public) = service_account();
        let fcm = Fcm::new(&account).unwrap();
        let now = 1_790_000_000;
        let (head, claims, signed, signature) = jwt::parts(&fcm.assertion(now).unwrap());
        assert_eq!(head, json!({ "alg": "RS256", "typ": "JWT" }));
        assert_eq!(
            claims,
            json!({
                "iss": "push@hive-test.iam.gserviceaccount.com",
                "scope": "https://www.googleapis.com/auth/firebase.messaging",
                "aud": "https://oauth2.googleapis.com/token",
                "iat": now,
                "exp": now + 3600,
            })
        );
        UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, &public)
            .verify(&signed, &signature)
            .expect("the assertion is signed by the account's key");
        let body = b"a notice, encrypted to the phone";
        let out = fcm.request(
            "a:token",
            data(body).unwrap(),
            86_400,
            Urgency::High,
            "access-1",
        );
        assert_eq!(
            out.url,
            "https://fcm.googleapis.com/v1/projects/hive-test/messages:send"
        );
        assert_eq!(
            header(&out, "authorization").as_deref(),
            Some("Bearer access-1")
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&out.body).unwrap(),
            json!({ "message": {
                "token": "a:token",
                "data": { "m": jwt::b64url(body) },
                "android": { "priority": "HIGH", "ttl": "86400s" },
            } })
        );
        let normal = fcm.request(
            "a:token",
            data(body).unwrap(),
            60,
            Urgency::Normal,
            "access-1",
        );
        let normal: Value = serde_json::from_slice(&normal.body).unwrap();
        assert_eq!(
            normal["message"]["android"],
            json!({ "priority": "NORMAL", "ttl": "60s" })
        );
        // An account without its key, or not JSON: refused as the server starts.
        assert!(Fcm::new(&json!({ "project_id": "p" }).to_string()).is_err());
        assert!(Fcm::new("not json").is_err());
    }

    #[tokio::test]
    async fn an_access_token_google_refuses_is_given_up_and_one_it_takes_is_kept() {
        let (account, _) = service_account();
        let fcm = Fcm::new(&account).unwrap();
        *fcm.access.lock().await = Some(("access-1".into(), u64::MAX));
        fcm.forget_access(500).await;
        assert!(fcm.access.lock().await.is_some());
        fcm.forget_access(401).await;
        assert!(fcm.access.lock().await.is_none());
    }

    #[test]
    fn a_notice_too_large_for_google_is_not_sent() {
        // The key and 4095 characters of base64url: 3071 bytes of notice.
        assert!(data(&[0; 3071]).is_some());
        assert!(data(&[0; 3072]).is_none());
    }

    #[test]
    fn a_phone_google_says_it_no_longer_knows_is_gone_and_any_other_answer_a_failure() {
        let unregistered = r#"{"error":{"code":404,"status":"NOT_FOUND","details":[{"@type":"type.googleapis.com/google.firebase.fcm.v1.FcmError","errorCode":"UNREGISTERED"}]}}"#;
        assert_eq!(passed(200, "{}"), Passed::Delivered);
        assert_eq!(passed(404, unregistered), Passed::Gone);
        assert_eq!(
            passed(400, &unregistered.replace("404", "400")),
            Passed::Gone
        );
        for (status, answer) in [
            (404, "<html>Not Found</html>"),
            (404, r#"{"error":{"status":"NOT_FOUND"}}"#),
            (400, r#"{"error":{"status":"INVALID_ARGUMENT"}}"#),
            (
                403,
                r#"{"error":{"details":[{"errorCode":"SENDER_ID_MISMATCH"}]}}"#,
            ),
            (429, r#"{"error":{"status":"QUOTA_EXCEEDED"}}"#),
            (503, ""),
        ] {
            assert!(
                matches!(passed(status, answer), Passed::Failed(_)),
                "{status} {answer}"
            );
        }
    }
}
