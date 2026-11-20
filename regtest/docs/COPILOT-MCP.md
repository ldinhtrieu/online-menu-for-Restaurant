# Dùng regtest qua GitHub Copilot (MCP)

Server MCP chạy **cục bộ trên máy bạn** (stdio). Nó **không gọi bất kỳ model AI nào**: AI chính là model Copilot bạn đang chọn trong VS Code. regtest lo phần xác định: chọn case theo `git diff`, chạy Playwright/API, báo cáo, kiểm tra định dạng, quản lý bản nháp.

## 1. Cài đặt (một lần)
```bash
cd regtest && npm install
npx playwright install chromium     # nếu máy chưa có trình duyệt cho Playwright
node bin/regtest.js init ../qa      # tạo ../qa/regtest.config.yaml + cases/ mẫu (bỏ qua nếu đã có)
```
Sửa `qa/regtest.config.yaml`: `baseUrl`, `apiBaseUrl`, các luật `impact` (đường dẫn code -> tag).

## 2. Khai báo MCP server trong VS Code
Tạo `.vscode/mcp.json` ở workspace (mẫu: `examples/vscode/mcp.json`):
```json
{
  "servers": {
    "regtest": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/regtest/bin/regtest-mcp.js", "--project", "${workspaceFolder}/qa"]
    }
  }
}
```
- Nhiều dự án: lặp `--project <dir>`; khi gọi tool truyền `project` (tên trong config hoặc tên thư mục).
- Mở Copilot Chat ở chế độ **Agent**, bật các tool của server `regtest` (nút Tools).
- Nếu không thấy MCP: quản trị Copilot của tổ chức có thể đã tắt MCP. Hãy hỏi IT; tôi không thể kiểm tra từ phía tool.
- Các tool ghi/chạy sẽ hỏi xác nhận trước khi thực thi, hãy đọc kỹ tham số.

## 3. Cách dùng
Chọn prompt có sẵn (gõ `/` trong Chat, mục MCP) hoặc nói tự nhiên:

| Mục tiêu | Prompt MCP | Ví dụ |
|---|---|---|
| Chạy regression cho thay đổi hiện tại | `regression_for_change` | "Chạy regression cho thay đổi so với origin/main" |
| Sinh case từ ticket | `generate_cases` | dán ticket vào tham số `input` |
| Điều tra và sửa case fail | `fix_failing_cases` | "Điều tra lần chạy gần nhất" |

## 4. Danh sách tool
| Nhóm | Tool |
|---|---|
| Dự án | `regtest_projects`, `regtest_init_project`, `regtest_get_config`, `regtest_add_impact_rule` |
| Case | `regtest_list_cases`, `regtest_get_case`, `regtest_authoring_guide` |
| Chọn & chạy | `regtest_select_cases` (xem trước và lý do), `regtest_run_cases`, `regtest_run_status`, `regtest_list_runs` |
| Kết quả | `regtest_get_results`, `regtest_get_failure` (kèm ảnh chụp), `regtest_triage_failures` |
| Soạn case | `regtest_validate_cases`, `regtest_save_draft`, `regtest_list_drafts`, `regtest_approve_draft`, `regtest_update_case_file` |

Quy ước an toàn:
- Case AI viết chỉ vào `drafts/` và **không chạy** cho đến khi bạn duyệt rồi gọi `regtest_approve_draft`.
- Tool chỉ ghi vào `cases/` và `drafts/` của dự án đã khai báo, và chỉ chạy dự án đã khai báo.
- Mỗi dự án chỉ chạy một lần tại một thời điểm.
- `regtest_triage_failures`: luật xử lý lỗi môi trường/5xx; còn lại model Copilot phân tích dựa trên bằng chứng (đừng sửa assertion để "làm xanh" một bug thật).

## 5. Dữ liệu đi đâu
Kết quả tool (lỗi, ảnh chụp, nội dung case) được gửi tới model Copilot như nội dung chat. Hãy tuân thủ chính sách dữ liệu của công ty; dùng môi trường test, không dùng dữ liệu thật.
