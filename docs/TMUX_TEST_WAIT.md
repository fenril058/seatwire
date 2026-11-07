# Waiting for the interrupt fixture

The existing tmux interrupt test waited for a marker file to exist, then immediately asserted its contents.
A Nix package check observed an empty marker instead of yes, while an unchanged rerun passed.
File existence can become visible before the write completes.
The fixture now separates creation and completion with a short delay, and the polling loop waits for the expected contents within the existing one-second bound.
The final assertion remains exactly yes; an empty or missing result still fails.

With the delayed fixture and the old polling predicate, the test failed on empty contents.
After changing the predicate, all 37 host Node tests passed with isolated state and substitute executables.
No production behavior or test selection changes.
