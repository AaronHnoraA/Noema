;; C/C++ project using Clang via nix-shell
;; shell.nix should expose clang/clang++ (llvmPackages.clang) in buildInputs.
((nil . ((indent-tabs-mode . nil)
         (tab-width . 4)
         (fill-column . 100)
         (my/project-local-settings
          . (:env  (("CC"  . "clang")
                   ("CXX" . "clang++"))
             :task (("build"     . "nix-shell --run 'make CC=clang CXX=clang++'")
                   ("configure" . "nix-shell --run 'cmake -B build -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++'")
                   ("test"      . "nix-shell --run 'ctest --test-dir build'"))))))
 (c-ts-mode   . ((compile-command . "nix-shell --run 'make CC=clang'") (c-basic-offset . 4)))
 (c++-ts-mode . ((compile-command . "nix-shell --run 'make CXX=clang++'") (c-basic-offset . 4)))
 (c-mode      . ((compile-command . "nix-shell --run 'make CC=clang'") (c-basic-offset . 4)))
 (c++-mode    . ((compile-command . "nix-shell --run 'make CXX=clang++'") (c-basic-offset . 4))))
