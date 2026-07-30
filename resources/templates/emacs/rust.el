;; Rust project using Cargo and rust-analyzer
((nil . ((indent-tabs-mode . nil)
         (tab-width . 4)
         (fill-column . 100)
         (compile-command . "cargo build")
         (my/project-local-settings
          . (:env (("RUST_BACKTRACE" . "1"))
             :test (("test"       . "cargo test")
                    ("test-fast"  . "cargo test --lib")
                    ("clippy"     . "cargo clippy --all-targets --all-features -- -D warnings"))
             :task (("build"     . "cargo build")
                    ("check"     . "cargo check")
                    ("clippy"    . "cargo clippy --all-targets --all-features")
                    ("fmt"       . "cargo fmt")
                    ("doc"       . "cargo doc --no-deps"))
             :run  (("run" . "cargo run"))))))
 (rust-mode
  . ((rust-indent-offset . 4)
     (compile-command . "cargo build")))
 (rust-ts-mode
  . ((rust-ts-indent-offset . 4)
     (compile-command . "cargo build"))))
