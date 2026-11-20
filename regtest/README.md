# regtest — runner regression dùng chung cho nhiều dự án

Mô tả test case bằng YAML (web + API), **chọn case cần chạy theo phần code đã thay đổi**, chạy song song, retry, báo cáo HTML có ảnh chụp khi lỗi. AI dùng **Claude CLI** (`claude -p`), đăng nhập bằng tài khoản của bạn, **không cần API key**: sinh case từ ticket/diff, phân tích lỗi. (Tự sửa selector: chưa làm.)

## Dùng nhanh
```bash
cd regtest && npm i
node bin/regtest.js init ../my-project/qa        # tạo regtest.config.yaml + case mẫu
node bin/regtest.js run --project ../my-project/qa --all
```
Thử ngay với demo: `node examples/demo/app/server.js &` rồi
`node bin/regtest.js run --project examples/demo --all`.

Trình duyệt: Playwright. Nếu máy đã có Chromium sẵn, đặt `REGTEST_CHROMIUM=/đường/dẫn/chrome`.

## Lệnh
| Lệnh | Ý nghĩa |
|---|---|
| `list` | liệt kê case |
| `select ...` | cho biết case nào sẽ chạy và **vì sao**, không chạy |
| `run ...` | chạy, ghi `.regtest/runs/<time>/report.html`, `results.json`, `junit.xml` |

Chọn case (hợp của các điều kiện): `--all`, `--changed [base]`, `--files a,b`, `--tags`, `--priority`, `--ids`.
Khác: `--workers`, `--retries`, `--screenshots all|failure|none`, `--headed`, `--project`.
Exit code: 0 pass hết, 1 có fail, 2 lỗi cấu hình.

## AI qua Claude CLI
Yêu cầu: đã cài Claude Code và `claude login`. Trên CI/server không đăng nhập tay được thì dùng `claude setup-token`.
```bash
regtest gen --from ticket.md --name my-feature     # hoặc --text "mô tả" hoặc --diff origin/main
# -> drafts/my-feature.yaml  (KHÔNG chạy ngay; người đọc/sửa trước)
regtest approve drafts/my-feature.yaml             # kiểm tra lại rồi chuyển vào cases/
regtest run --changed origin/main --explain        # chạy regression, rồi phân loại lỗi
regtest explain                                    # phân loại lỗi của lần chạy gần nhất
```
- `gen`: AI chỉ được dùng đúng các action của runner; output được validate, sai thì tự yêu cầu sửa 1 lần. Chỗ AI đoán selector/endpoint được ghi chú `# ASSUMPTION` để người duyệt kiểm tra.
- `explain`: luật đơn giản xử lý trước (app không lên, 5xx) không tốn AI; các lỗi còn lại gộp **một** lần gọi. Có cache theo nội dung.
- Tiết kiệm: `ai.models` dùng model nhỏ cho `explain`, model mạnh cho `gen`; `ai.maxCalls` đặt trần số lần gọi; mỗi lệnh in tổng token và số lần gọi.
- Ví dụ: `examples/demo/ticket-DEMO-12.md`.
- Lưu ý: giải thích của AI chỉ là gợi ý (có thể sai, ví dụ đoán nhầm lỗi do case viết sai là flaky). Case AI viết cần người duyệt trước khi tin kết quả.

```yaml
ai: { provider: claude-cli, command: claude, models: { gen: sonnet, explain: haiku }, maxCalls: 5 }
```

## Chọn regression theo impact
`regtest.config.yaml`:
```yaml
impact:                          # đường dẫn code (tính từ gốc git) -> tag
  - paths: ["menu-ui/src/cart/**"]
    tags: [cart]
  - paths: ["**/*.md"]
    tags: []                     # biết chắc không ảnh hưởng
alwaysRun: { tags: [smoke] }     # luôn chạy khi dùng --changed
onUnmapped: all                  # file đổi mà không khớp rule nào -> chạy TẤT CẢ (an toàn)
```
Mỗi case có thể gắn `tags` và/hoặc `covers: [glob code]`. `regtest run --changed origin/main` lấy `git diff` (so với base, cộng cả thay đổi chưa commit), tìm tag bị ảnh hưởng và chạy các case khớp + smoke.
Khi tính năng mới đụng chức năng cũ, chỉ cần thêm rule/tag; case cũ được tái sử dụng.

## Viết case
```yaml
id: ORD-002
title: Tạo order rồi đọc lại
priority: P0            # P0..P3
tags: [order]
covers: ["menu-be/**/order*"]
vars: { user: admin }
steps:
  - api: { method: POST, url: /api/orders, body: { items: [Pho] }, expectStatus: 201,
           expectJson: { status: NEW, id: $exists }, save: { orderId: id } }
  - goto: /orders/${orderId}
  - expectText: { selector: "#status", equals: NEW }
teardown:
  - api: { method: DELETE, url: "/api/orders/${orderId}", expectStatus: [200, 204] }
```
Một file có thể chứa nhiều case: `tags:` chung + `cases: [...]`.

Action: `goto click fill press select check wait waitFor expectText expectVisible expectHidden expectUrl expectCount screenshot set api`.
`api`: `method url headers body expectStatus expectJson save saveHeader`. `expectJson` hỗ trợ `$exists $absent {$contains} {$gt} {$regex}`.
Biến: `${name}` (từ `vars`/`save`), `${env.NAME}`. `teardown` luôn chạy, kể cả khi bước trước lỗi.

## Lưu ý thiết kế
- Mỗi case dùng browser context riêng (không dính cookie/state nhau). Case lỗi được retry; pass ở lần retry sẽ gắn **FLAKY**.
- Báo cáo đánh dấu **REGRESSION** nếu case pass ở lần chạy trước nhưng fail lần này.
- Cùng một bộ case chạy được trên môi trường khác bằng `REGTEST_BASE_URL` / `REGTEST_API_URL`.
- Chưa có bước DB (dựng data / verify bằng SQL), mobile app, và AI tự sửa selector. Cấu trúc `steps.js` cho phép thêm action mới ở một chỗ.
