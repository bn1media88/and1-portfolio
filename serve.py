"""Máy chủ nhỏ cho landing page: mở trang trong trình duyệt và lưu thay đổi khi bấm "Xong".

- POST /api/save               : ghi nội dung trang vào content.js, rồi chuyển video không còn dùng
                                 trong videos/ vào Thùng rác
- POST /api/upload?name=&dir=videos : chép video tải lên vào videos/
Chỉ nghe ở 127.0.0.1 (máy này). Chạy: python serve.py  (hoặc bấm đúp "Mo trang.bat")
"""
import http.server
import json
import os
import re
import socket
import urllib.request
import webbrowser
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent
UPLOAD_DIRS = {"videos"}
CHUNK = 1 << 20


def write_atomic(path: Path, data: bytes):
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


MEDIA_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}


def referenced(data) -> set:
    """Mọi đường dẫn "videos/..." mà nội dung trang đang dùng (chữ thường để so trên Windows)."""
    out = set()
    prefixes = tuple(f"{d}/" for d in UPLOAD_DIRS)

    def walk(o):
        if isinstance(o, dict):
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
        elif isinstance(o, str) and o.startswith(prefixes):
            out.add(unquote(o.split("#")[0].split("?")[0]).lower())

    walk(data)
    return out


def to_trash(paths):
    """Chuyển file vào Thùng rác Windows (khôi phục được). NO_RECYCLE=1 thì xóa hẳn (dùng khi chạy thử)."""
    if not paths:
        return
    if os.name != "nt" or os.environ.get("NO_RECYCLE"):
        for p in paths:
            p.unlink(missing_ok=True)
        return
    import ctypes
    from ctypes import wintypes

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [("hwnd", wintypes.HWND), ("wFunc", wintypes.UINT), ("pFrom", wintypes.LPCWSTR),
                    ("pTo", wintypes.LPCWSTR), ("fFlags", ctypes.c_uint16), ("fAnyOperationsAborted", wintypes.BOOL),
                    ("hNameMappings", ctypes.c_void_p), ("lpszProgressTitle", wintypes.LPCWSTR)]

    FO_DELETE, FOF_SILENT, FOF_NOCONFIRMATION, FOF_ALLOWUNDO, FOF_NOERRORUI = 3, 0x4, 0x10, 0x40, 0x400
    op = SHFILEOPSTRUCTW(wFunc=FO_DELETE, pFrom="\0".join(str(p) for p in paths) + "\0",
                         fFlags=FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOERRORUI)
    if ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op)):
        raise OSError("không chuyển được file vào Thùng rác")


def clean_unused(data) -> list:
    """Video trong videos/ mà trang không còn dùng -> Thùng rác. Trả về danh sách đã dọn."""
    refs = referenced(data)
    unused = [p for d in sorted(UPLOAD_DIRS) if (ROOT / d).is_dir()
              for p in sorted((ROOT / d).iterdir())
              if p.is_file() and p.suffix.lower() in MEDIA_EXT and f"{d}/{p.name}".lower() not in refs]
    to_trash(unused)
    return [f"{p.parent.name}/{p.name}" for p in unused]


def safe_name(name: str) -> str:
    name = re.sub(r'[#?%\\/:*"<>|\x00-\x1f]', "-", Path(name).name).strip(" .")
    return name or "video.mp4"


def free_path(path: Path) -> Path:
    """Trùng tên thì thêm -2, -3... (không ghi đè video cũ)."""
    if not path.exists():
        return path
    i = 2
    while (p := path.with_name(f"{path.stem}-{i}{path.suffix}")).exists():
        i += 1
    return p


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def log_message(self, *args):
        pass

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---------- Đọc ----------
    def do_GET(self):
        if urlparse(self.path).path == "/api/ping":
            return self.send_json(200, {"ok": True})
        rng = self.headers.get("Range")
        if rng and self.send_range(rng):
            return
        super().do_GET()

    def send_range(self, rng) -> bool:
        """Trả một đoạn file (206) để video tua được."""
        path = Path(self.translate_path(self.path))
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng.strip())
        if not path.is_file() or not m or m.groups() == ("", ""):
            return False
        size = path.stat().st_size
        start, end = m.groups()
        if start == "":
            start, end = max(0, size - int(end)), size - 1
        else:
            start, end = int(start), min(int(end) if end else size - 1, size - 1)
        if start > end:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return True
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(CHUNK, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)
        return True

    # ---------- Ghi ----------
    def do_POST(self):
        # Header riêng: trang web lạ không gửi được (bị trình duyệt chặn CORS) -> không ai khác ghi đè file được.
        # Kiểm tra thêm Host: chặn trang lạ trỏ tên miền của nó về 127.0.0.1 (DNS rebinding).
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        if self.headers.get("X-Landing") != "1" or host not in ("127.0.0.1", "localhost"):
            return self.send_json(403, {"error": "không được phép"})
        url = urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        try:
            if url.path == "/api/save":
                data = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(data, dict) or "text" not in data or "projects" not in data:
                    raise ValueError("nội dung không hợp lệ")
                js = ('// Nội dung trang — tự ghi khi bấm "Xong" trong chế độ chỉnh sửa (hoặc nút "Xuất content.js").\n'
                      f"window.SITE_CONTENT = {json.dumps(data, ensure_ascii=False, indent=2)};\n")
                write_atomic(ROOT / "content.js", js.encode("utf-8"))
                print("Đã lưu content.js")
                try:
                    removed = clean_unused(data)
                except OSError as e:  # dọn lỗi không làm hỏng việc lưu
                    print("Không dọn được file thừa:", e)
                    removed = []
                for r in removed:
                    print("Chuyển vào Thùng rác:", r)
                return self.send_json(200, {"ok": True, "removed": removed})

            if url.path == "/api/upload":
                q = parse_qs(url.query)
                folder = q.get("dir", ["videos"])[0]
                if folder not in UPLOAD_DIRS:
                    raise ValueError("thư mục không hợp lệ")
                dest = ROOT / folder
                dest.mkdir(exist_ok=True)
                target = free_path(dest / safe_name(q.get("name", [""])[0]))
                tmp = target.with_name(target.name + ".tmp")
                left = length
                with open(tmp, "wb") as f:
                    while left > 0:
                        chunk = self.rfile.read(min(CHUNK, left))
                        if not chunk:
                            break
                        f.write(chunk)
                        left -= len(chunk)
                if left:
                    tmp.unlink(missing_ok=True)
                    raise ValueError("tải lên bị ngắt giữa chừng")
                os.replace(tmp, target)
                print(f"Đã chép file: {folder}/{target.name}")
                return self.send_json(200, {"src": f"{folder}/{target.name}"})
        except Exception as e:
            return self.send_json(400, {"error": str(e)})
        self.send_json(404, {"error": "không có"})


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    # Trên Windows SO_REUSEADDR cho phép 2 chương trình cùng chiếm 1 cổng -> tắt đi
    allow_reuse_address = os.name != "nt"

    def handle_error(self, request, client_address):
        pass  # trình duyệt ngắt kết nối khi tua/đổi video — bình thường, không in lỗi


# Luôn dùng 1 cổng: trình duyệt lưu bản nháp / video tải lên riêng theo từng cổng,
# đổi cổng là bản nháp chưa lưu "biến mất".
PORT = int(os.environ.get("PORT") or 8080)


def port_busy(port) -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def is_our_server(port) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=2) as r:
            return json.load(r).get("ok") is True
    except Exception:
        return False


if __name__ == "__main__":
    port = PORT
    url = f"http://127.0.0.1:{port}/"
    if port_busy(port):
        if is_our_server(port):  # cửa sổ Mo trang.bat cũ vẫn đang chạy -> chỉ mở lại trang
            print(f"Trang đã chạy sẵn tại {url} (cửa sổ Mo trang.bat khác đang mở).")
            if not os.environ.get("NO_BROWSER"):
                webbrowser.open(url)
            raise SystemExit(0)
        raise SystemExit(f"Cổng {port} đang bị chương trình khác dùng. Tắt chương trình đó rồi chạy lại.")
    httpd = Server(("127.0.0.1", port), Handler)
    print(f"Trang đang chạy tại {url}")
    print('Sửa xong bấm "✓ Xong" là lưu vào content.js. Đóng cửa sổ này để tắt.')
    if not os.environ.get("NO_BROWSER"):
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
