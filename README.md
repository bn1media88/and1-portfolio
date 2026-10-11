# Bn1.media — Video Editor Portfolio

Trang portfolio một trang cho video editor: giới thiệu, phần mềm sử dụng, liên hệ, video showreel và các dự án theo thể loại. HTML/CSS/JS thuần, không cần build.

## Xem trang

Mở `index.html` bằng trình duyệt, hoặc đưa cả thư mục lên hosting tĩnh bất kỳ.
Trên hosting, thanh chỉnh sửa được ẩn với khách xem; thêm `?edit` vào cuối link để hiện.

## Triển khai lên Cloudflare Pages (từ GitHub)

Không cần build. Trong Cloudflare: **Workers & Pages → Create → Pages → Connect to Git** → chọn repo, rồi đặt:

| Mục | Giá trị |
| --- | --- |
| Framework preset | `None` |
| Build command | *(để trống)* |
| Build output directory | `/` |

### Video: phát từ Cloudflare R2 (bắt buộc khi deploy)

File video **không được đưa lên GitHub** (`.gitignore` loại mọi `.mp4/.mov/.mkv/.webm/.m4v` trong `videos/`),
vì vượt giới hạn GitHub (100 MB/file) và Cloudflare Pages (25 MB/file). Bản trên Pages lấy video từ R2:

1. Tạo bucket R2, tải video lên **giữ nguyên thư mục**: `videos/hero.mp4`, `videos/du-an-1.mp4`, …
   (tên file nên viết không dấu, không khoảng trắng; nên nén cho web, H.264 1080p ~5–15 MB/video).
2. Bật truy cập công khai cho bucket bằng tên miền riêng, vd `media.ten-mien.com`
   (địa chỉ `r2.dev` chỉ dùng thử, bị giới hạn tốc độ).
3. Sửa `config.js`: `window.VIDEO_BASE_URL = 'https://media.ten-mien.com';` rồi đẩy lên GitHub.

`content.js` vẫn giữ đường dẫn `videos/...`; trang tự ghép thành `https://media.ten-mien.com/videos/...`.
Trên máy (mở bằng `Mo trang.bat`), để trống `VIDEO_BASE_URL` thì video phát từ thư mục `videos/`.

**CORS:** không cần. Hiệu ứng ánh sáng quanh video chỉ vẽ hình lên canvas, không đọc dữ liệu điểm ảnh.
Chỉ khi sau này thêm `crossorigin` vào thẻ `<video>` mới phải cấu hình CORS cho bucket, nếu không video sẽ không phát.

## Chỉnh sửa nội dung

1. Bấm đúp **`Mo trang.bat`** (cần [Python](https://www.python.org/downloads/)), trang mở tại `http://127.0.0.1:8080`.
2. Bấm **✎ Chỉnh sửa** → sửa chữ trực tiếp, rê chuột lên khung video để tải video lên / dán link, bấm biểu tượng liên hệ để nhập link.
3. Bấm **✓ Xong** → nội dung được ghi thẳng vào `content.js`, video vào `videos/`. Video không còn dùng được chuyển vào Thùng rác.

## Cấu trúc

| File | Vai trò |
| --- | --- |
| `index.html` | Bố cục trang |
| `style.css` | Giao diện (máy tính + điện thoại) |
| `app.js` | Hiệu ứng, trình phát video, chế độ chỉnh sửa |
| `content.js` | Toàn bộ chữ, link liên hệ, danh sách video (tự ghi khi bấm Xong) |
| `config.js` | Cấu hình triển khai: `VIDEO_BASE_URL` (nơi chứa video, để trống = dùng `videos/`) |
| `serve.py`, `Mo trang.bat` | Máy chủ nhỏ trên máy để lưu thay đổi vào file |
| `videos/`, `icons/`, `logo-bn1*.png` | Video, biểu tượng, logo |
