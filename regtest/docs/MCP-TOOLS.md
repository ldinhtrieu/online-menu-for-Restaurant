# Chức năng của regtest MCP server

Server MCP chạy cục bộ (stdio), khởi động bằng `node regtest/bin/regtest-mcp.js --project <dir>`.
**Server không gọi model AI nào.** Model của client (ví dụ GitHub Copilot) là AI; regtest cung cấp các tool dưới đây.

Quy ước: `*` = tham số bắt buộc. Mọi tool đều nhận thêm `project` (tên trong config hoặc tên thư mục), chỉ cần khi cấu hình nhiều dự án.
Cột "Loại": **Đọc** = không thay đổi gì; **Ghi** = ghi file; **Chạy** = chạy test thật (gọi app qua mạng).

## 1. Dự án và cấu hình

| Tool | Loại | Chức năng | Tham số |
|---|---|---|---|
| `regtest_projects` | Đọc | Liệt kê các dự án server đang quản lý: tên, thư mục, baseUrl, số case, số file case lỗi | – |
| `regtest_init_project` | Ghi | Tạo `regtest.config.yaml` và `cases/sample.yaml` trong một thư mục **nằm trong workspace**, rồi thêm vào danh sách dự án | `dir`* |
| `regtest_get_config` | Đọc | Xem cấu hình hiệu lực: baseUrl, apiBaseUrl, retries, workers, timeout, screenshots, alwaysRun, onUnmapped, luật impact. Giá trị `headers` được che (`***`) | – |
| `regtest_add_impact_rule` | Ghi | Thêm luật "đường dẫn code → tag" vào `regtest.config.yaml`, giữ nguyên comment trong file. `tags: []` nghĩa là "các đường dẫn này không ảnh hưởng case nào" | `paths`*, `tags`* |

## 2. Quản lý case

| Tool | Loại | Chức năng | Tham số |
|---|---|---|---|
| `regtest_list_cases` | Đọc | Liệt kê case (id, tiêu đề, ưu tiên, tag, file, covers). Lọc theo tag, ưu tiên hoặc từ khóa trong id/tiêu đề | `tag`, `priority`, `query` |
| `regtest_get_case` | Đọc | Trả về một case đã chuẩn hóa (kèm các bước) và nội dung YAML gốc của file chứa nó | `id`* |
| `regtest_authoring_guide` | Đọc | "Sổ tay" để viết case hợp lệ: định dạng YAML, danh sách action, tag và id đã có (tránh trùng), luật impact, base URL, ví dụ, quy tắc. Gọi trước khi viết case | – |

## 3. Chọn case cần chạy (regression theo impact)

| Tool | Loại | Chức năng | Tham số |
|---|---|---|---|
| `regtest_select_cases` | Đọc | Chạy thử việc chọn, **không chạy test**: cho biết case nào được chọn và **vì sao** (`impact:<tag>`, `covers:<file>`, `alwaysRun`, `id`, `tag`…), các tag bị ảnh hưởng, file thay đổi không khớp luật nào. File đổi không khớp luật sẽ khiến chạy tất cả, trừ khi config đặt `onUnmapped: ignore` | xem bên dưới |

Tham số chọn (dùng chung cho `regtest_select_cases` và `regtest_run_cases`, kết quả là hợp các điều kiện; không truyền gì thì chọn tất cả):

| Tham số | Ý nghĩa |
|---|---|
| `all` | Tất cả case |
| `ids` | Danh sách id case |
| `tags` | Case có ít nhất một tag trong danh sách |
| `priorities` | Case có mức ưu tiên trong danh sách (P0, P1…) |
| `changed` | `true` = lấy file thay đổi từ git (cả chưa commit); chuỗi = nhánh gốc, ví dụ `"origin/main"` |
| `files` | Danh sách file thay đổi chỉ định tay (tính từ gốc git) thay cho việc đọc git |

## 4. Chạy test và xem kết quả

| Tool | Loại | Chức năng | Tham số |
|---|---|---|---|
| `regtest_run_cases` | Chạy | Chạy các case đã chọn (Playwright cho web, HTTP cho API). Mặc định chạy nền và trả về `runId`. Mỗi dự án chỉ chạy một lần tại một thời điểm | tham số chọn, `workers` (1-8), `retries` (0-3), `screenshots` (`all`/`failure`/`none`), `waitSeconds` (0-300, chờ xong trong cùng lời gọi) |
| `regtest_run_status` | Đọc | Trạng thái lần chạy hiện tại hoặc đã qua: đang chạy/xong/lỗi, tiến độ, case lỗi tới lúc này, tổng kết, đường dẫn báo cáo HTML | `runId`, `waitSeconds` (0-120) |
| `regtest_list_runs` | Đọc | Danh sách các lần chạy gần đây (mới nhất trước) kèm tổng kết | `limit` (1-50, mặc định 10) |
| `regtest_get_results` | Đọc | Kết quả từng case của một lần chạy (mặc định lần mới nhất): trạng thái, lỗi, số lần thử, lý do được chọn, cờ **REGRESSION** (lần trước pass, lần này fail) và **FLAKY** (pass sau khi retry) | `runId`, `status` (`all`/`failed`/`passed`), `includeSteps` |
| `regtest_get_failure` | Đọc | Chi tiết một case lỗi: lỗi, các bước, kết quả phân loại theo luật và **ảnh chụp màn hình** bước lỗi (trả về dạng ảnh, tối đa khoảng 1,5 MB) | `caseId`*, `runId`, `includeScreenshot` |
| `regtest_triage_failures` | Đọc | Phân loại lỗi của một lần chạy. Luật tự xử lý: app không kết nối được hoặc lỗi cổng (`environment`), 5xx (`backend-error`). Các lỗi còn lại trả về trong `needsAnalysis` kèm bằng chứng gọn để model của client phân tích (`ui-changed` / `real-bug` / `data` / `flaky` / `unknown`) | `runId` |

Mỗi lần chạy sinh ra `.regtest/runs/<thời gian>/` gồm `report.html`, `results.json`, `junit.xml` và ảnh chụp.

## 5. Soạn, duyệt và sửa case

| Tool | Loại | Chức năng | Tham số |
|---|---|---|---|
| `regtest_validate_cases` | Đọc | Kiểm tra YAML theo định dạng case và trùng id với case đã có, không lưu gì | `yaml`* |
| `regtest_save_draft` | Ghi | Kiểm tra rồi lưu vào thư mục `drafts/`. **Bản nháp chưa chạy** cho đến khi được duyệt. YAML sai thì không lưu | `name`*, `yaml`* |
| `regtest_list_drafts` | Đọc | Liệt kê bản nháp đang chờ duyệt và id các case trong đó | `includeContent` |
| `regtest_approve_draft` | Ghi | Kiểm tra lại rồi chuyển bản nháp vào `cases/` để thành một phần của bộ regression. Chỉ gọi sau khi người dùng đã xem. Từ chối nếu trùng id hoặc trùng tên file | `name`* |
| `regtest_update_case_file` | Ghi | Thay nội dung một file case **đã có** (ví dụ sửa selector sau khi UI đổi). YAML được kiểm tra trước, sai hoặc trùng id thì không ghi | `file`*, `yaml`* |

## 6. Prompt có sẵn (chọn bằng `/` trong Copilot Chat)

| Prompt | Mục đích | Tham số |
|---|---|---|
| `regression_for_change` | Chọn và chạy các case bị ảnh hưởng bởi thay đổi hiện tại, theo dõi đến khi xong, phân loại lỗi, **đề xuất** (không tự áp dụng) cách sửa case hỏng vì UI đổi | `base`, `project` |
| `generate_cases` | Viết case cho một ticket hoặc diff theo định dạng đúng, kiểm tra, lưu thành bản nháp, rồi yêu cầu người dùng duyệt | `input`*, `project` |
| `fix_failing_cases` | Điều tra lần chạy lỗi, phân loại từng case, chỉ sửa case hỏng vì UI đổi (sau khi người dùng đồng ý) rồi chạy lại đúng các case đó. Không nới lỏng assertion để che bug thật | `runId`, `project` |

## 7. Action trong case (viết bằng YAML)

Mỗi bước có đúng một action:

| Nhóm | Action |
|---|---|
| Điều hướng và thao tác web | `goto`, `click`, `fill`, `press`, `select`, `check` |
| Chờ | `wait` (ms), `waitFor` (selector) |
| Kiểm tra web | `expectVisible`, `expectHidden`, `expectText` (`equals` hoặc `contains`), `expectCount`, `expectUrl` |
| Khác | `screenshot`, `set` (gán biến) |
| API | `api`: `method`, `url`, `headers`, `body`, `expectStatus`, `expectJson` (hỗ trợ `$exists`, `$absent`, `$contains`, `$gt`, `$regex`), `save` (lưu giá trị từ response vào biến), `saveHeader` |

Biến: `${ten}` (từ `vars` hoặc `save`), `${env.TEN}`. Phần `teardown` luôn chạy, kể cả khi bước trước lỗi.

## 8. Ràng buộc an toàn

- Chỉ làm việc với dự án đã khai báo bằng `--project` (hoặc biến `REGTEST_PROJECTS`) hoặc vừa tạo bằng `regtest_init_project`.
- Chỉ ghi vào `cases/`, `drafts/`, `regtest.config.yaml` và `.regtest/` của dự án. Đường dẫn thoát khỏi thư mục (kiểu `../..`) bị từ chối.
- YAML tối đa 200 KB. Một dự án chỉ chạy một lần tại một thời điểm.
- Case do AI viết không chạy cho đến khi được duyệt (`regtest_approve_draft`).
- Server không gọi model AI nào; dữ liệu tool trả về (lỗi, ảnh chụp, nội dung case) sẽ do client gửi tới model của nó.

## 9. Chưa có

Bước truy vấn DB, mobile app, fixture dùng chung (`use:`), các action kéo thả, upload/download file, hộp thoại trình duyệt, nhiều tab, iframe; chỉ chạy Chromium cỡ 1280×800. Tool cũng chưa được thử với dự án thật.
