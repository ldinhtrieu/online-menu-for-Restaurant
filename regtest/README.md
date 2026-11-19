# regtest — runner regression dùng chung cho nhiều dự án

Mô tả test case bằng YAML (web + API), **chọn case cần chạy theo phần code đã thay đổi**, chạy song song, retry, báo cáo HTML có ảnh chụp khi lỗi. Chưa có AI (sẽ thêm sau: sinh case, tự sửa selector, giải thích lỗi).

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
- Chưa có bước DB (dựng data / verify bằng SQL), mobile app, và AI. Cấu trúc `steps.js` cho phép thêm action mới ở một chỗ.
