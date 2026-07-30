;; C/C++ project using GCC via nix-shell
;; shell.nix should expose gcc/g++ in its buildInputs.
((nil . ((indent-tabs-mode . nil)
         (tab-width . 4)
         (fill-column . 100)
         (my/project-local-settings
          . (:env  (("CC"  . "gcc")
                   ("CXX" . "g++"))
             :task (("build"     . "nix-shell --run 'make CC=gcc'")
                   ("configure" . "nix-shell --run 'cmake -B build -DCMAKE_C_COMPILER=gcc -DCMAKE_CXX_COMPILER=g++'")
                   ("test"      . "nix-shell --run 'ctest --test-dir build'"))))))
 (c-ts-mode   . ((compile-command . "nix-shell --run 'make'") (c-basic-offset . 4)))
 (c++-ts-mode . ((compile-command . "nix-shell --run 'make'") (c-basic-offset . 4)))
 (c-mode      . ((compile-command . "nix-shell --run 'make'") (c-basic-offset . 4)))
 (c++-mode    . ((compile-command . "nix-shell --run 'make'") (c-basic-offset . 4))))
