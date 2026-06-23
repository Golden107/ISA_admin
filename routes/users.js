const express = require('express');
const router = express.Router();
const db = require('../db');

// 權限驗證中介軟體：檢查請求者是否為高階主管
const requireAdmin = (req, res, next) => {
    const role = req.headers['x-user-role'];

    // 💡 放寬權限：允許資安長、班主任、管理部主任進入管理後台
    const allowedRoles = ['CISO', 'PRINCIPAL', 'DIRECTOR'];

    if (!allowedRoles.includes(role)) {
        return res.status(403).json({ success: false, message: '權限不足，僅限高階主管執行此系統設定操作。' });
    }
    next();
};

// API: 取得所有使用者清單 (基於安全性考量，不回傳密碼欄位)
router.get('/', requireAdmin, async (req, res) => {
    try {
        const [users] = await db.query('SELECT id, name, email, role FROM users ORDER BY id DESC');
        res.json({ success: true, data: users });
    } catch (error) {
        res.status(500).json({ success: false, error: '資料庫讀取失敗' });
    }
});

// API: 新增使用者
router.post('/', requireAdmin, async (req, res) => {
    const { name, email, password, role } = req.body;
    try {
        await db.query(
            'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
            [name, email, password, role]
        );
        res.json({ success: true, message: '使用者新增成功' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: '新增失敗，請確認該信箱是否已存在' });
    }
});

// API: 更新使用者資料與權限
router.put('/:id', requireAdmin, async (req, res) => {
    const userId = req.params.id;
    const { name, email, password, role } = req.body;
    try {
        if (password) {
            await db.query(
                'UPDATE users SET name = ?, email = ?, password_hash = ?, role = ? WHERE id = ?',
                [name, email, password, role, userId]
            );
        } else {
            await db.query(
                'UPDATE users SET name = ?, email = ?, role = ? WHERE id = ?',
                [name, email, role, userId]
            );
        }
        res.json({ success: true, message: '資料更新成功' });
    } catch (error) {
        res.status(500).json({ success: false, error: '系統更新失敗' });
    }
});

// API: 刪除使用者
router.delete('/:id', requireAdmin, async (req, res) => {
    const userId = req.params.id;
    try {
        await db.query('DELETE FROM users WHERE id = ?', [userId]);
        res.json({ success: true, message: '使用者刪除成功' });
    } catch (error) {
        res.status(500).json({ success: false, error: '刪除失敗，該名員工可能已有關聯之表單紀錄。' });
    }
});

module.exports = router;