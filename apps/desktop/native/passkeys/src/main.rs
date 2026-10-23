use qrcode::{render::svg, QrCode};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, Read, Write};
use url::Url;
use webauthn_authenticator_rs::{
    cable::connect_cable_authenticator,
    types::{CableRequestType, CableState, EnrollSampleStatus},
    ui::UiCallback,
    AuthenticatorBackendHashedClientData,
};
use webauthn_rs_proto::PublicKeyCredentialRequestOptions;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    origin: String,
    public_key: PublicKeyCredentialRequestOptions,
}

fn emit(value: Value) {
    let mut output = io::stdout().lock();
    if serde_json::to_writer(&mut output, &value).is_err()
        || output.write_all(b"\n").is_err()
        || output.flush().is_err()
    {
        std::process::exit(1);
    }
}

#[derive(Debug)]
struct Ui;

impl UiCallback for Ui {
    fn request_pin(&self) -> Option<String> {
        None
    }
    fn request_touch(&self) {}
    fn processing(&self) {}
    fn fingerprint_enrollment_feedback(&self, _: u32, _: Option<EnrollSampleStatus>) {}
    fn cable_qr_code(&self, _: CableRequestType, url: String) {
        match QrCode::new(url.as_bytes()) {
            Ok(code) => emit(
                json!({"type": "qr", "svg": code.render::<svg::Color>().min_dimensions(280, 280).build()}),
            ),
            Err(_) => {
                emit(json!({"type": "error", "code": "NotAllowedError"}));
                std::process::exit(1);
            }
        }
    }
    fn dismiss_qr_code(&self) {
        emit(json!({"type": "waiting"}));
    }
    fn cable_status_update(&self, _: CableState) {}
}

fn validate_request(request: &Request) -> Result<Url, &'static str> {
    let origin = Url::parse(&request.origin).map_err(|_| "SecurityError")?;
    let host = origin.host_str().ok_or("SecurityError")?;
    let rp = &request.public_key.rp_id;
    if origin.origin().ascii_serialization() != request.origin
        || !(origin.scheme() == "https" || (origin.scheme() == "http" && host == "localhost"))
        || !(host == rp || host.ends_with(&format!(".{rp}")))
        || (rp != "localhost" && psl::domain_str(rp).is_none())
        || request.public_key.challenge.is_empty()
        || request.public_key.challenge.len() > 4096
        || request.public_key.allow_credentials.len() > 64
        || request
            .public_key
            .allow_credentials
            .iter()
            .any(|credential| {
                credential.type_ != "public-key"
                    || credential.id.is_empty()
                    || credential.id.len() > 4096
            })
        || request.public_key.extensions.is_some()
    {
        return Err("SecurityError");
    }
    Ok(origin)
}

async fn authenticate(request: Request) -> Result<Value, &'static str> {
    validate_request(&request)?;
    let discoverable = request.public_key.allow_credentials.is_empty();
    let requires_uv =
        serde_json::to_value(request.public_key.user_verification).ok() == Some(json!("required"));
    let timeout = request
        .public_key
        .timeout
        .unwrap_or(120_000)
        .clamp(1, 120_000);
    let ui = Ui;
    let mut authenticator = connect_cable_authenticator(CableRequestType::GetAssertion, &ui)
        .await
        .map_err(|_| "NotAllowedError")?;
    let client_data = serde_json::to_vec(&json!({
        "type": "webauthn.get", "challenge": request.public_key.challenge,
        "origin": request.origin, "crossOrigin": false,
    }))
    .map_err(|_| "NotAllowedError")?;
    let mut credential = AuthenticatorBackendHashedClientData::perform_auth(
        &mut authenticator,
        openssl::sha::sha256(&client_data).to_vec(),
        request.public_key,
        timeout,
    )
    .map_err(|_| "NotAllowedError")?;
    credential.response.client_data_json = client_data.into();
    let data = credential.response.authenticator_data.as_slice();
    if data.len() < 37
        || data[32] & 1 == 0
        || (requires_uv && data[32] & 4 == 0)
        || (discoverable && credential.response.user_handle.is_none())
    {
        return Err("NotAllowedError");
    }
    serde_json::to_value(credential).map_err(|_| "NotAllowedError")
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let mut input = String::new();
    if io::stdin().take(65_537).read_to_string(&mut input).is_err() || input.len() > 65_536 {
        emit(json!({"type": "error", "code": "SecurityError"}));
        return;
    }
    let request: Request = match serde_json::from_str(&input) {
        Ok(request) => request,
        Err(_) => {
            emit(json!({"type": "error", "code": "SecurityError"}));
            return;
        }
    };
    match authenticate(request).await {
        Ok(credential) => emit(json!({"type": "result", "credential": credential})),
        Err(code) => emit(json!({"type": "error", "code": code})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_cbor_2::Value as Cbor;
    use std::collections::BTreeMap;
    use webauthn_authenticator_rs::ctap2::commands::GetAssertionResponse;

    #[test]
    fn preserves_discoverable_credential_user_handle() {
        let response = GetAssertionResponse::try_from(BTreeMap::from([(
            4,
            Cbor::Map(BTreeMap::from([(
                Cbor::Text("id".into()),
                Cbor::Bytes(vec![1, 2, 3]),
            )])),
        )]))
        .unwrap();
        assert_eq!(response.user_handle.unwrap().as_slice(), &[1, 2, 3]);
    }

    #[test]
    fn rejects_cross_origin_and_public_suffix_rp_ids() {
        for rp in ["other.example", "com", "co.uk", "github.io"] {
            let request: Request = serde_json::from_value(json!({
                "origin": "https://login.example.com", "publicKey": {
                    "rpId": rp, "challenge": "AQID", "allowCredentials": [], "userVerification": "required"
                }
            })).unwrap();
            assert!(validate_request(&request).is_err());
        }
    }
}
