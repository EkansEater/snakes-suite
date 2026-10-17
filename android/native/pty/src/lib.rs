//! Pseudo-terminals for Snake's Code and Snake's Terminal on Android: what node-pty does on the desktop.
//!
//! `spawn` opens a pty, forks, and runs the shell on the child side. Kotlin
//! reads and writes the returned master fd (through a ParcelFileDescriptor),
//! resizes it with `resize`, and collects the exit code with `waitFor`.

use std::ffi::CString;
use std::ptr;

use jni::objects::{JClass, JObjectArray, JString};
use jni::sys::{jint, jintArray};
use jni::JNIEnv;

fn strings(env: &mut JNIEnv, arr: &JObjectArray) -> Vec<CString> {
    let n = env.get_array_length(arr).unwrap_or(0);
    (0..n)
        .filter_map(|i| {
            let o = env.get_object_array_element(arr, i).ok()?;
            let s: String = env.get_string(&JString::from(o)).ok()?.into();
            CString::new(s).ok()
        })
        .collect()
}

/// Starts `argv[0]` with `argv` and `envp` in `cwd` on a new pty. Returns [masterFd, pid].
#[no_mangle]
pub extern "system" fn Java_com_snake_suite_code_NativePty_spawn(
    mut env: JNIEnv, _: JClass, argv: JObjectArray, envp: JObjectArray, cwd: JString, cols: jint, rows: jint,
) -> jintArray {
    let argv = strings(&mut env, &argv);
    let envp = strings(&mut env, &envp);
    let cwd: String = env.get_string(&cwd).map(|s| s.into()).unwrap_or_else(|_| "/".into());
    let cwd = CString::new(cwd).unwrap_or_else(|_| CString::new("/").unwrap());
    if argv.is_empty() {
        let _ = env.throw_new("java/io/IOException", "no program to run");
        return ptr::null_mut();
    }

    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    let ws = libc::winsize { ws_row: rows.max(1) as u16, ws_col: cols.max(1) as u16, ws_xpixel: 0, ws_ypixel: 0 };
    // Everything the child needs is prepared before fork: after it, only async-signal-safe calls.
    let mut argv_ptrs: Vec<*const libc::c_char> = argv.iter().map(|s| s.as_ptr()).collect();
    argv_ptrs.push(ptr::null());
    let mut envp_ptrs: Vec<*const libc::c_char> = envp.iter().map(|s| s.as_ptr()).collect();
    envp_ptrs.push(ptr::null());

    unsafe {
        if libc::openpty(&mut master, &mut slave, ptr::null_mut(), ptr::null(), &ws) != 0 {
            let _ = env.throw_new("java/io/IOException", "openpty failed");
            return ptr::null_mut();
        }
        let pid = libc::fork();
        if pid < 0 {
            libc::close(master);
            libc::close(slave);
            let _ = env.throw_new("java/io/IOException", "fork failed");
            return ptr::null_mut();
        }
        if pid == 0 {
            // Child: new session with the pty as its controlling terminal and stdio.
            libc::close(master);
            libc::setsid();
            libc::ioctl(slave, libc::TIOCSCTTY as _, 0);
            libc::dup2(slave, 0);
            libc::dup2(slave, 1);
            libc::dup2(slave, 2);
            if slave > 2 {
                libc::close(slave);
            }
            // Close everything else the app had open.
            for fd in 3..1024 {
                libc::close(fd);
            }
            // Signals the JVM blocks must not stay blocked in the shell.
            let mut set: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut set);
            libc::sigprocmask(libc::SIG_SETMASK, &set, ptr::null_mut());
            libc::chdir(cwd.as_ptr());
            libc::execve(argv_ptrs[0], argv_ptrs.as_ptr(), envp_ptrs.as_ptr());
            libc::_exit(127);
        }
        libc::close(slave);
        let out = match env.new_int_array(2) {
            Ok(a) => a,
            Err(_) => return ptr::null_mut(),
        };
        let _ = env.set_int_array_region(&out, 0, &[master, pid]);
        out.into_raw()
    }
}

#[no_mangle]
pub extern "system" fn Java_com_snake_suite_code_NativePty_resize(_: JNIEnv, _: JClass, fd: jint, cols: jint, rows: jint) {
    let ws = libc::winsize { ws_row: rows.max(1) as u16, ws_col: cols.max(1) as u16, ws_xpixel: 0, ws_ypixel: 0 };
    unsafe {
        libc::ioctl(fd, libc::TIOCSWINSZ as _, &ws);
    }
}

/// Waits for the process and returns its exit code (128 + signal when killed).
#[no_mangle]
pub extern "system" fn Java_com_snake_suite_code_NativePty_waitFor(_: JNIEnv, _: JClass, pid: jint) -> jint {
    let mut status: libc::c_int = 0;
    unsafe {
        while libc::waitpid(pid, &mut status, 0) < 0 {
            if *libc::__errno() != libc::EINTR {
                return -1;
            }
        }
        if libc::WIFEXITED(status) {
            libc::WEXITSTATUS(status)
        } else if libc::WIFSIGNALED(status) {
            128 + libc::WTERMSIG(status)
        } else {
            -1
        }
    }
}

/// Sends SIGHUP to the shell's process group, as closing a terminal does.
#[no_mangle]
pub extern "system" fn Java_com_snake_suite_code_NativePty_hangup(_: JNIEnv, _: JClass, pid: jint) {
    unsafe {
        libc::kill(-pid, libc::SIGHUP);
        libc::kill(pid, libc::SIGHUP);
    }
}

// The same four calls for Snake's Terminal (its NativePty class lives in its own package).
#[no_mangle]
pub extern "system" fn Java_com_snake_suite_terminal_NativePty_spawn(
    env: JNIEnv, class: JClass, argv: JObjectArray, envp: JObjectArray, cwd: JString, cols: jint, rows: jint,
) -> jintArray {
    Java_com_snake_suite_code_NativePty_spawn(env, class, argv, envp, cwd, cols, rows)
}

#[no_mangle]
pub extern "system" fn Java_com_snake_suite_terminal_NativePty_resize(env: JNIEnv, class: JClass, fd: jint, cols: jint, rows: jint) {
    Java_com_snake_suite_code_NativePty_resize(env, class, fd, cols, rows)
}

#[no_mangle]
pub extern "system" fn Java_com_snake_suite_terminal_NativePty_waitFor(env: JNIEnv, class: JClass, pid: jint) -> jint {
    Java_com_snake_suite_code_NativePty_waitFor(env, class, pid)
}

#[no_mangle]
pub extern "system" fn Java_com_snake_suite_terminal_NativePty_hangup(env: JNIEnv, class: JClass, pid: jint) {
    Java_com_snake_suite_code_NativePty_hangup(env, class, pid)
}
