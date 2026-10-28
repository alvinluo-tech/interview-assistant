//! Rebrand only a newly staged copy. Original binaries are never modified.
use std::{os::windows::ffi::OsStrExt, path::Path};
use windows::{
    Win32::{
        Foundation::{FreeLibrary, HMODULE},
        System::LibraryLoader::*,
    },
    core::{BOOL, PCWSTR},
};

fn word(data: &mut Vec<u8>, value: u16) {
    data.extend(value.to_le_bytes());
}
fn align(data: &mut Vec<u8>) {
    while !data.len().is_multiple_of(4) {
        data.push(0);
    }
}
fn utf16(data: &mut Vec<u8>, value: &str) {
    for c in value.encode_utf16().chain(Some(0)) {
        word(data, c);
    }
}
fn block(key: &str, kind: u16, value_len: u16, value: &[u8], children: &[Vec<u8>]) -> Vec<u8> {
    let mut data = Vec::new();
    word(&mut data, 0);
    word(&mut data, value_len);
    word(&mut data, kind);
    utf16(&mut data, key);
    align(&mut data);
    data.extend(value);
    for child in children {
        align(&mut data);
        data.extend(child);
    }
    let length = u16::try_from(data.len()).expect("validated version resource fits WORD");
    data[0..2].copy_from_slice(&length.to_le_bytes());
    data
}

fn version_info(name: &str) -> Vec<u8> {
    let exe = format!("{name}.exe");
    let strings = [
        ("FileDescription", name),
        ("ProductName", name),
        ("InternalName", &exe),
        ("OriginalFilename", &exe),
        ("FileVersion", "1.0.0.0"),
        ("ProductVersion", "1.0.0.0"),
    ]
    .into_iter()
    .map(|(key, value)| {
        let mut bytes = Vec::new();
        utf16(&mut bytes, value);
        block(key, 1, (bytes.len() / 2) as u16, &bytes, &[])
    })
    .collect::<Vec<_>>();
    let fixed: Vec<u8> = [
        0xFEEF04BDu32,
        0x00010000,
        0x00010000,
        0,
        0x00010000,
        0,
        0x3F,
        0,
        0x00040004,
        1,
        0,
        0,
        0,
    ]
    .into_iter()
    .flat_map(u32::to_le_bytes)
    .collect();
    let table = block("040904B0", 1, 0, &[], &strings);
    let translation = block("Translation", 0, 4, &[0x09, 0x04, 0xB0, 0x04], &[]);
    block(
        "VS_VERSION_INFO",
        0,
        fixed.len() as u16,
        &fixed,
        &[
            block("StringFileInfo", 1, 0, &[], &[table]),
            block("VarFileInfo", 1, 0, &[], &[translation]),
        ],
    )
}

#[derive(Clone)]
enum ResourceName {
    Id(u16),
    Text(Vec<u16>),
}
impl ResourceName {
    unsafe fn copy(pointer: PCWSTR) -> Self {
        if pointer.0 as usize <= u16::MAX as usize {
            Self::Id(pointer.0 as usize as u16)
        } else {
            Self::Text(
                unsafe { pointer.as_wide() }
                    .iter()
                    .copied()
                    .chain(Some(0))
                    .collect(),
            )
        }
    }
    fn pointer(&self) -> PCWSTR {
        match self {
            Self::Id(id) => PCWSTR(*id as usize as *const u16),
            Self::Text(value) => PCWSTR(value.as_ptr()),
        }
    }
}
struct Resource {
    kind: u16,
    name: ResourceName,
    language: u16,
}
struct Enumeration {
    resources: Vec<Resource>,
    error: Option<String>,
}

unsafe extern "system" fn collect_language(
    _: HMODULE,
    kind: PCWSTR,
    name: PCWSTR,
    language: u16,
    context: isize,
) -> BOOL {
    let output = unsafe { &mut *(context as *mut Enumeration) };
    output.resources.push(Resource {
        kind: kind.0 as usize as u16,
        name: unsafe { ResourceName::copy(name) },
        language,
    });
    BOOL(1)
}
unsafe extern "system" fn collect_name(
    module: HMODULE,
    kind: PCWSTR,
    name: PCWSTR,
    context: isize,
) -> BOOL {
    if let Err(error) = unsafe {
        EnumResourceLanguagesW(
            Some(module),
            kind,
            PCWSTR(name.0),
            Some(collect_language),
            context,
        )
    } {
        unsafe { &mut *(context as *mut Enumeration) }.error = Some(error.to_string());
        return BOOL(0);
    }
    BOOL(1)
}

fn enumerate(path: &Path) -> Result<Vec<Resource>, String> {
    let wide: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // Map as data only: this never executes code from the staged file.
    let module = unsafe {
        LoadLibraryExW(
            PCWSTR(wide.as_ptr()),
            None,
            LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE,
        )
    }
    .map_err(|e| e.to_string())?;
    let mut output = Enumeration {
        resources: vec![],
        error: None,
    };
    for kind in [3u16, 14, 16] {
        let result = unsafe {
            EnumResourceNamesW(
                Some(module),
                PCWSTR(kind as usize as *const u16),
                Some(collect_name),
                &mut output as *mut _ as isize,
            )
        };
        if !result.as_bool() && output.error.is_none() {
            let error = windows::core::Error::from_thread();
            // A binary is allowed to contain no icons or version resources.
            if ![1812, 1813].contains(&(error.code().0 as u32 & 0xffff)) {
                output.error = Some(error.to_string());
            }
        }
    }
    unsafe { FreeLibrary(module) }.map_err(|e| e.to_string())?;
    if let Some(error) = output.error {
        Err(error)
    } else {
        Ok(output.resources)
    }
}

pub fn rebrand(path: &Path, name: &str) -> Result<(), String> {
    let resources = enumerate(path)?;
    let wide: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let handle =
        unsafe { BeginUpdateResourceW(PCWSTR(wide.as_ptr()), false) }.map_err(|e| e.to_string())?;
    let data = version_info(name);
    let result = (|| {
        for resource in resources {
            unsafe {
                UpdateResourceW(
                    handle,
                    PCWSTR(resource.kind as usize as *const u16),
                    resource.name.pointer(),
                    resource.language,
                    None,
                    0,
                )
            }
            .map_err(|e| e.to_string())?;
        }
        unsafe {
            UpdateResourceW(
                handle,
                PCWSTR(16usize as *const u16),
                PCWSTR(1usize as *const u16),
                0x409,
                Some(data.as_ptr().cast()),
                data.len() as u32,
            )
        }
        .map_err(|e| e.to_string())
    })();
    if let Err(error) = result {
        let _ = unsafe { EndUpdateResourceW(handle, true) };
        return Err(error);
    }
    unsafe { EndUpdateResourceW(handle, false) }.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn staged_binary_loses_all_icon_resources_and_keeps_one_version() {
        let root =
            std::env::temp_dir().join(format!("mianshi-resource-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("Example.exe");
        std::fs::copy(std::env::current_exe().unwrap(), &path).unwrap();
        // Seed nonstandard IDs/languages to ensure enumeration, not fixed ranges, is used.
        let wide: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let handle = unsafe { BeginUpdateResourceW(PCWSTR(wide.as_ptr()), false) }.unwrap();
        let payload = [1u8, 2, 3, 4];
        unsafe {
            UpdateResourceW(
                handle,
                PCWSTR(3usize as *const u16),
                PCWSTR(900usize as *const u16),
                0x804,
                Some(payload.as_ptr().cast()),
                4,
            )
            .unwrap();
            EndUpdateResourceW(handle, false).unwrap();
        }
        rebrand(&path, "DesktopHelper").unwrap();
        let resources = enumerate(&path).unwrap();
        assert_eq!(resources.len(), 1);
        assert_eq!(resources[0].kind, 16);
        assert_eq!(resources[0].language, 0x409);
        assert!(std::fs::read(&path).unwrap().windows(26).any(|bytes| {
            bytes
                == "DesktopHelper"
                    .encode_utf16()
                    .flat_map(u16::to_le_bytes)
                    .collect::<Vec<_>>()
        }));
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn version_tree_is_aligned_and_lengths_are_valid() {
        fn verify(data: &[u8], expected: &str) {
            let length = u16::from_le_bytes(data[0..2].try_into().unwrap()) as usize;
            assert_eq!(length, data.len());
            let key: Vec<u16> = data[6..]
                .chunks_exact(2)
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .take_while(|v| *v != 0)
                .collect();
            assert_eq!(String::from_utf16(&key).unwrap(), expected);
            let value_start = (6 + (key.len() + 1) * 2).next_multiple_of(4);
            let mut value_len = u16::from_le_bytes(data[2..4].try_into().unwrap()) as usize;
            if data[4] == 1 {
                value_len *= 2;
            }
            let mut child = (value_start + value_len).next_multiple_of(4);
            while child < length {
                let child_len =
                    u16::from_le_bytes(data[child..child + 2].try_into().unwrap()) as usize;
                assert!(child_len >= 6 && child + child_len <= length);
                let child_key: Vec<_> = data[child + 6..]
                    .chunks_exact(2)
                    .map(|b| u16::from_le_bytes([b[0], b[1]]))
                    .take_while(|v| *v != 0)
                    .collect();
                verify(
                    &data[child..child + child_len],
                    &String::from_utf16(&child_key).unwrap(),
                );
                child = (child + child_len).next_multiple_of(4);
            }
        }
        verify(&version_info("Helper"), "VS_VERSION_INFO");
    }
}
