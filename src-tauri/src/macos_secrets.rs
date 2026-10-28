//! One Keychain master key; versioned AES-256-GCM ciphertexts stay in the settings store.
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};

const HEADER: &[u8] = b"MLAI\x01";
const AAD: &[u8] = b"com.mianlingai.clone.byok.v1";
const ERROR: &str =
    "无法读取或保存 macOS 加密密钥，请解锁钥匙串并允许访问；密钥丢失时请重新配置 AI 服务";

#[cfg(target_os = "macos")]
fn master_key(service: &str, create: bool) -> Result<Vec<u8>, String> {
    use security_framework::passwords::{PasswordOptions, generic_password, set_generic_password};
    let account = "settings-master-key-v1";
    let key = match generic_password(PasswordOptions::new_generic_password(service, account)) {
        Ok(key) => key,
        // Never replace an inaccessible key, or create a key while decrypting old data.
        Err(error) if create && error.code() == -25300 => {
            let mut key = vec![0u8; 32];
            SystemRandom::new().fill(&mut key).map_err(|_| ERROR)?;
            set_generic_password(service, account, &key).map_err(|_| ERROR)?;
            key
        }
        Err(_) => return Err(ERROR.into()),
    };
    if key.len() != 32 {
        return Err(ERROR.into());
    }
    Ok(key)
}

#[cfg(target_os = "macos")]
pub fn crypt(input: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    let key = master_key("com.mianlingai.clone.byok", protect)?;
    crypt_with_key(input, protect, &key)
}

fn crypt_with_key(input: &[u8], protect: bool, master: &[u8]) -> Result<Vec<u8>, String> {
    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, master).map_err(|_| ERROR)?,
    );
    if protect {
        let mut nonce = [0u8; 12];
        SystemRandom::new().fill(&mut nonce).map_err(|_| ERROR)?;
        let mut encrypted = input.to_vec();
        key.seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::from(AAD),
            &mut encrypted,
        )
        .map_err(|_| ERROR)?;
        Ok([HEADER, &nonce, &encrypted].concat())
    } else {
        if input.len() < HEADER.len() + 12 + aead::AES_256_GCM.tag_len()
            || !input.starts_with(HEADER)
        {
            return Err(ERROR.into());
        }
        let offset = HEADER.len();
        let nonce = aead::Nonce::try_assume_unique_for_key(&input[offset..offset + 12])
            .map_err(|_| ERROR)?;
        let mut encrypted = input[offset + 12..].to_vec();
        let decrypted = key
            .open_in_place(nonce, aead::Aad::from(AAD), &mut encrypted)
            .map_err(|_| ERROR)?;
        Ok(decrypted.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ciphertext_roundtrip_uses_fresh_nonces_and_rejects_tampering() {
        let master = [7u8; 32];
        let original = b"dummy-test-credential";
        let first = crypt_with_key(original, true, &master).unwrap();
        let second = crypt_with_key(original, true, &master).unwrap();
        assert_ne!(first, second);
        assert!(!first.windows(original.len()).any(|part| part == original));
        assert_eq!(crypt_with_key(&first, false, &master).unwrap(), original);
        assert!(crypt_with_key(&first, false, &[8u8; 32]).is_err());
        for index in [0, HEADER.len(), first.len() - 1] {
            let mut damaged = first.clone();
            damaged[index] ^= 1;
            assert!(crypt_with_key(&damaged, false, &master).is_err());
        }
        assert!(crypt_with_key(b"truncated", false, &master).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn keychain_master_key_is_reused_and_missing_keys_are_not_replaced_on_read() {
        use security_framework::passwords::delete_generic_password;
        // Isolated test entry; never touch the application's real master key.
        let service = format!("com.mianlingai.clone.byok.test.{}", std::process::id());
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = delete_generic_password(&self.0, "settings-master-key-v1");
            }
        }
        let _cleanup = Cleanup(service.clone());
        assert!(master_key(&service, false).is_err());
        let created = master_key(&service, true).unwrap();
        assert_eq!(created.len(), 32);
        assert_eq!(master_key(&service, false).unwrap(), created);
        assert_eq!(master_key(&service, true).unwrap(), created);
    }
}
