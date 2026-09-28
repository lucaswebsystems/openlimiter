//! Handle relative access on Unix; pinned, non deletable directories on Windows.
//! Only the supplied state root is canonicalized. No child path is resolved.
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
};

pub fn unsafe_path() -> io::Error {
    io::Error::other("activity: unsafe storage")
}

pub struct Directory {
    pub path: PathBuf,
    #[cfg_attr(windows, allow(dead_code))] // Pins the directory even without path relative APIs.
    handle: File,
    // On Windows these handles deny deletion, including directory replacement.
    _root: Option<Box<Directory>>,
}

pub struct Entries {
    #[cfg(unix)]
    directory: *mut libc::DIR,
    #[cfg(windows)]
    directory: fs::ReadDir,
}

impl Iterator for Entries {
    type Item = io::Result<std::ffi::OsString>;
    fn next(&mut self) -> Option<Self::Item> {
        #[cfg(windows)]
        {
            self.directory
                .next()
                .map(|entry| entry.map(|v| v.file_name()))
        }
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            loop {
                let entry = unsafe { libc::readdir(self.directory) };
                if entry.is_null() {
                    return None;
                }
                let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
                if name == b"." || name == b".." {
                    continue;
                }
                return Some(Ok(std::ffi::OsString::from_vec(name.to_vec())));
            }
        }
    }
}

#[cfg(unix)]
impl Drop for Entries {
    fn drop(&mut self) {
        unsafe {
            libc::closedir(self.directory);
        }
    }
}

fn linked(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}

fn private(meta: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o077 == 0
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        true
    }
}

#[cfg(windows)]
fn windows_identity(file: &File) -> io::Result<(u32, u64, u32)> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    #[derive(Default)]
    struct Info {
        attributes: u32,
        times: [u32; 6],
        volume: u32,
        size: [u32; 2],
        links: u32,
        high: u32,
        low: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, info: *mut Info) -> i32;
    }
    let mut info = Info::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((
        info.volume,
        (u64::from(info.high) << 32) | u64::from(info.low),
        info.links,
    ))
}

fn regular(file: &File, limit: u64) -> io::Result<()> {
    let meta = file.metadata()?;
    if linked(&meta) || !meta.is_file() || !private(&meta) || meta.len() > limit {
        return Err(unsafe_path());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() != 1 {
            return Err(unsafe_path());
        }
    }
    #[cfg(windows)]
    if windows_identity(file)?.2 != 1 {
        return Err(unsafe_path());
    }
    Ok(())
}

impl Directory {
    pub fn entries(&self) -> io::Result<Entries> {
        #[cfg(windows)]
        {
            Ok(Entries {
                directory: fs::read_dir(&self.path)?,
            })
        }
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            // Enumerate the held directory, even if its pathname is replaced.
            let fd = unsafe { libc::fcntl(self.handle.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            let directory = unsafe { libc::fdopendir(fd) };
            if directory.is_null() {
                let error = io::Error::last_os_error();
                unsafe {
                    libc::close(fd);
                }
                return Err(error);
            }
            Ok(Entries { directory })
        }
    }
    pub fn root(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(unsafe_path());
        }
        let path = fs::canonicalize(path)?;
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x0220_0000).share_mode(3);
        }
        let handle = options.open(&path)?;
        let meta = handle.metadata()?;
        if linked(&meta) || !meta.is_dir() {
            return Err(unsafe_path());
        }
        Ok(Self {
            path,
            handle,
            _root: None,
        })
    }

    fn open(&self, name: &str, directory: bool, create: bool) -> io::Result<File> {
        if Path::new(name).components().count() != 1
            || !matches!(
                Path::new(name).components().next(),
                Some(Component::Normal(_))
            )
        {
            return Err(unsafe_path());
        }
        #[cfg(unix)]
        {
            use std::os::fd::{AsRawFd, FromRawFd};
            let name = std::ffi::CString::new(name).map_err(|_| unsafe_path())?;
            let flags = libc::O_CLOEXEC
                | libc::O_NOFOLLOW
                | libc::O_NONBLOCK
                | if directory { libc::O_DIRECTORY } else { 0 }
                | if create {
                    libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL
                } else {
                    libc::O_RDONLY
                };
            let fd = unsafe { libc::openat(self.handle.as_raw_fd(), name.as_ptr(), flags, 0o600) };
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(unsafe { File::from_raw_fd(fd) })
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let mut options = OpenOptions::new();
            options
                .read(!create)
                .write(create)
                .create_new(create)
                .share_mode(3)
                .custom_flags(0x0020_0000 | if directory { 0x0200_0000 } else { 0 });
            if create {
                options.access_mode(0x4004_0000);
            }
            options.open(self.path.join(name))
        }
    }

    pub fn activity(self) -> io::Result<Self> {
        let handle = self.open("activity", true, false)?;
        let meta = handle.metadata()?;
        if linked(&meta) || !meta.is_dir() || !private(&meta) {
            return Err(unsafe_path());
        }
        Ok(Self {
            path: self.path.join("activity"),
            handle,
            _root: Some(Box::new(self)),
        })
    }

    pub fn read(&self, name: &str, limit: u64) -> io::Result<Vec<u8>> {
        let file = self.open(name, false, false)?;
        regular(&file, limit)?;
        let mut bytes = Vec::new();
        (&file).take(limit + 1).read_to_end(&mut bytes)?;
        regular(&file, limit)?;
        if bytes.len() as u64 > limit {
            return Err(unsafe_path());
        }
        Ok(bytes)
    }

    pub fn metadata(&self, name: &str, directory: bool) -> io::Result<Metadata> {
        let file = self.open(name, directory, false)?;
        let meta = file.metadata()?;
        if linked(&meta) || (directory && !meta.is_dir()) {
            return Err(unsafe_path());
        }
        if !directory {
            regular(&file, u64::MAX)?;
        }
        Ok(meta)
    }

    pub fn write(&self, name: &str, bytes: &[u8]) -> io::Result<()> {
        // Existing destinations must also be safe. rename never follows one.
        match self.metadata(name, false) {
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        let temporary = format!(".activity-desktop-{}.tmp", uuid::Uuid::new_v4());
        let result = (|| {
            let mut file = self.open(&temporary, false, true)?;
            #[cfg(windows)]
            protect(&file)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            #[cfg(unix)]
            {
                use std::os::fd::AsRawFd;
                let from = std::ffi::CString::new(temporary.as_str()).unwrap();
                let to = std::ffi::CString::new(name).map_err(|_| unsafe_path())?;
                if unsafe {
                    libc::renameat(
                        self.handle.as_raw_fd(),
                        from.as_ptr(),
                        self.handle.as_raw_fd(),
                        to.as_ptr(),
                    )
                } != 0
                {
                    return Err(io::Error::last_os_error());
                }
                self.handle.sync_all()?;
            }
            #[cfg(windows)]
            fs::rename(self.path.join(&temporary), self.path.join(name))?;
            Ok(())
        })();
        if result.is_err() {
            #[cfg(unix)]
            {
                use std::os::fd::AsRawFd;
                let name = std::ffi::CString::new(temporary).unwrap();
                unsafe {
                    libc::unlinkat(self.handle.as_raw_fd(), name.as_ptr(), 0);
                }
            }
            #[cfg(windows)]
            {
                let _ = fs::remove_file(self.path.join(temporary));
            }
        }
        result
    }
}

// A protected current user DACL, set on the open file before writing bytes.
// File ownership can be Administrators on Windows, so OWNER RIGHTS alone does
// not reliably grant the unelevated creating user access after closing it.
#[cfg(windows)]
fn protect(file: &File) -> io::Result<()> {
    use std::{ffi::c_void, os::windows::io::AsRawHandle};
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
            text: *const u16,
            revision: u32,
            descriptor: *mut *mut c_void,
            size: *mut u32,
        ) -> i32;
        fn SetKernelObjectSecurity(
            handle: *mut c_void,
            information: u32,
            descriptor: *mut c_void,
        ) -> i32;
        fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
        fn GetTokenInformation(
            token: *mut c_void,
            class: u32,
            info: *mut c_void,
            size: u32,
            needed: *mut u32,
        ) -> i32;
        fn ConvertSidToStringSidW(sid: *mut c_void, text: *mut *mut u16) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }
    use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::GetCurrentProcess};
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), 8, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut needed = 0;
    unsafe {
        GetTokenInformation(token, 1, std::ptr::null_mut(), 0, &mut needed);
    }
    // Word aligned storage for TOKEN_USER, whose first member is the SID ptr.
    let mut info = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
    let got =
        unsafe { GetTokenInformation(token, 1, info.as_mut_ptr().cast(), needed, &mut needed) };
    let error = io::Error::last_os_error();
    unsafe {
        CloseHandle(token);
    }
    if got == 0 || info.is_empty() {
        return Err(error);
    }
    let mut sid_text = std::ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(info[0] as *mut c_void, &mut sid_text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut length = 0;
    unsafe {
        while *sid_text.add(length) != 0 {
            length += 1;
        }
    }
    let sid = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(sid_text, length) });
    unsafe {
        LocalFree(sid_text.cast());
    }
    let text: Vec<u16> = format!("D:P(A;;FA;;;{sid})\0").encode_utf16().collect();
    let mut descriptor = std::ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            text.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let result = unsafe { SetKernelObjectSecurity(file.as_raw_handle(), 0x8000_0004, descriptor) };
    let error = io::Error::last_os_error();
    unsafe {
        LocalFree(descriptor);
    }
    if result == 0 {
        Err(error)
    } else {
        Ok(())
    }
}
