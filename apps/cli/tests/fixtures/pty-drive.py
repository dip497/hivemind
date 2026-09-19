# Runs a command in a real pty of the given size, types keys, prints its output.
# pty-drive.py <cols> <rows> <start-delay-s> <keys, \x00 = pause> -- cmd...
import codecs, fcntl, os, pty, select, struct, sys, termios, time

cols, rows, delay = int(sys.argv[1]), int(sys.argv[2]), float(sys.argv[3])
keys = codecs.decode(sys.argv[4], "unicode_escape")
cmd = sys.argv[sys.argv.index("--") + 1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
out, start, sent = b"", time.time(), False
while time.time() - start < 20:
    if not sent and time.time() - start > delay:
        for part in keys.split("\x00"):
            os.write(fd, part.encode())
            time.sleep(0.8)
        sent = True
    if select.select([fd], [], [], 0.1)[0]:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode("utf8", "replace") + f"\n<<exit {os.waitstatus_to_exitcode(status)}>>\n")
