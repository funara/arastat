//! Windows Job Object binding: the engine child is killed by the kernel when
//! ARAStat exits, crashes, or is force-killed from Task Manager.

#![cfg(windows)]

use std::ffi::c_void;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

/// Owns one job-object handle. Closing it terminates every assigned process.
pub struct ProcessJob {
    handle: HANDLE,
}

// SAFETY: a Windows HANDLE is an opaque kernel handle value. Kernel object
// handles are process-wide and may be used or closed from any thread, so moving
// this owner between threads is sound (the type is not Sync because Drop closes
// the handle exactly once).
unsafe impl Send for ProcessJob {}

impl ProcessJob {
    /// Create a kill-on-close job and assign `process` to it.
    ///
    /// SAFETY: `process` must be a live process handle owned by the caller; the
    /// handle is only read here and never closed by this type.
    pub fn assign(process: HANDLE) -> Result<Self, String> {
        if process.is_null() {
            return Err("no engine process handle to guard".to_string());
        }
        // SAFETY: null attributes and name request the default unnamed job.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(format!(
                "CreateJobObjectW failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let job = Self { handle };

        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `job.handle` is a live job handle and `limits` outlives the call.
        let ok = unsafe {
            SetInformationJobObject(
                job.handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(format!(
                "SetInformationJobObject failed: {}",
                std::io::Error::last_os_error()
            ));
        }

        // SAFETY: both handles are live; assignment transfers no ownership.
        let ok = unsafe { AssignProcessToJobObject(job.handle, process) };
        if ok == 0 {
            return Err(format!(
                "AssignProcessToJobObject failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(job)
    }
}

impl Drop for ProcessJob {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            // SAFETY: the handle is owned by this type and closed exactly once.
            unsafe { CloseHandle(self.handle) };
            self.handle = std::ptr::null_mut();
        }
    }
}
