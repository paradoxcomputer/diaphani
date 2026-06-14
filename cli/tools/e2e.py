#!/usr/bin/env python3
# Deterministic pty driver for the diaphani setup wizard.
#
# Usage: e2e.py <HOME> <DIAPHANI_SCRIPTS> <step> [<step> ...]
#   Each <step> is sent to the wizard, one per ~1s, after a startup wait.
#   Tokens:
#     ""        -> Enter (accept default / select highlighted)
#     "ENTER"   -> Enter
#     "DOWN"    -> down-arrow   (no Enter)   e.g. to move a select cursor
#     "UP"      -> up-arrow
#     "<text>"  -> type <text> then Enter
#
# Prints the ANSI-stripped transcript. Always exits 0 (assert on side effects).
import os, pty, time, threading, sys, re, signal

CLI_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # .../cli


def encode(tok):
    if tok in ("", "ENTER"):
        return b"\r"
    if tok == "DOWN":
        return b"\x1b[B"
    if tok == "UP":
        return b"\x1b[A"
    return tok.encode() + b"\r"


def main():
    home, scripts = sys.argv[1], sys.argv[2]
    steps = sys.argv[3:]
    env = dict(os.environ)
    env.update(HOME=home, DIAPHANI_SCRIPTS=scripts, DIAPHANI_PLAIN="1",
               NO_COLOR="1", FORCE_COLOR="0")

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(CLI_DIR)
        os.execvpe("node", ["node", "bin/diaphani.js", "setup"], env)

    buf = bytearray()
    dead = threading.Event()

    def reader():
        while not dead.is_set():
            try:
                d = os.read(fd, 4096)
            except OSError:
                break
            if not d:
                break
            buf.extend(d)

    threading.Thread(target=reader, daemon=True).start()
    time.sleep(2.8)  # banner + detect() spinner, first prompt appears
    for s in steps:
        os.write(fd, encode(s))
        time.sleep(1.0)
    time.sleep(2.0)
    dead.set()
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass

    txt = buf.decode("utf-8", "replace")
    txt = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", txt)
    txt = re.sub(r"\x1b\][^\x07]*\x07", "", txt)
    sys.stdout.write(txt)


if __name__ == "__main__":
    main()
