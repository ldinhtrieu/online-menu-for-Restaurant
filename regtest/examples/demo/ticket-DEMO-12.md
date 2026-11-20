DEMO-12: Giới hạn số lượng món trong giỏ hàng.
Giỏ hàng của trang menu (http://localhost:4010) tối đa 5 món. Khi đã đủ 5 món, bấm thêm món nữa sẽ không tăng số đếm (#count) 
và hiển thị thông báo lỗi trong #msg: "Tối đa 5 món". Checkout giỏ rỗng trả 400 {error: "empty cart"}.
Các nút thêm món: .add[data-n='Pho'], .add[data-n='Banh mi']. Giỏ hiển thị trong #cart, nút #checkout.
API: POST /api/orders {items:[...]} -> 201 {id,items,status:"NEW"}; GET /api/orders/:id.
