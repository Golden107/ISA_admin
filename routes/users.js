const express = require('express');
const router = express.Router();
const db = require('../db');

// 🛡️ 資安守門員：檢查請求者是否為資安長
const requireCISO = (req, res, next) => {
    // 實務上應從 JWT 或 Session 取出，這裡我們先從前端 Header 傳入的 role 來檢查
    const role = req.headers['x-user-role'];
    if (role !== 'CISO') {
        return res.status(403).json({ success: false, message: '權限不足，僅限資安長執行此操作！' });
    }
    next();
};

// 1. 取得所有使用者清單 (不回傳密碼以策安全)
router.get('/', requireCISO, async (req, res) => {
    try {
        const [users] = await db.query('SELECT id, name, email, role FROM users ORDER BY id DESC');
        res.json({ success: true, data: users });
    } catch (error) {
        res.status(500).json({ success: false, error: '資料庫讀取失敗' });
    }
});

// 2. 新增使用者
router.post('/', requireCISO, async (req, res) => {
    const { name, email, password, role } = req.body;
    try {
        await db.query(
            'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
            [name, email, password, role]
        );
        res.json({ success: true, message: '使用者新增成功' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: '新增失敗 (信箱可能已重複)' });
    }
});

// 3. 更新使用者資料與權限
router.put('/:id', requireCISO, async (req, res) => {
    const userId = req.params.id;
    const { name, email, password, role } = req.body;
    try {
        if (password) {
            // 如果有填寫密碼，就連密碼一起更新
            await db.query(
                'UPDATE users SET name = ?, email = ?, password_hash = ?, role = ? WHERE id = ?',
                [name, email, password, role, userId]
            );
        } else {
            // 如果密碼留空，就只更新其他資料
            await db.query(
                'UPDATE users SET name = ?, email = ?, role = ? WHERE id = ?',
                [name, email, role, userId]
            );
        }
        res.json({ success: true, message: '資料更新成功' });
    } catch (error) {
        res.status(500).json({ success: false, error: '更新失敗' });
    }
});

// 4. 刪除使用者
router.delete('/:id', requireCISO, async (req, res) => {
    const userId = req.params.id;
    try {
        await db.query('DELETE FROM users WHERE id = ?', [userId]);
        res.json({ success: true, message: '使用者已刪除' });
    } catch (error) {
        res.status(500).json({ success: false, error: '刪除失敗 (該使用者可能尚有綁定的表單紀錄)' });
    }
});

module.exports = router;