const express = require('express');
const router = express.Router();
const db = require('../db');

const requireAdmin = (req, res, next) => {
    const role = req.headers['x-user-role'];
    const allowedRoles = ['CISO', 'PRINCIPAL', 'DIRECTOR'];
    if (!allowedRoles.includes(role)) {
        return res.status(403).json({ success: false, message: '權限不足，僅限高階主管執行此系統設定操作。' });
    }
    next();
};

// 💡 讓請假單下拉選單可以抓到公司所有人員
router.get('/list/basic', async (req, res) => {
    try {
        const [users] = await db.query('SELECT id, name, role FROM users ORDER BY id ASC');
        res.json({ success: true, data: users });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

router.get('/', requireAdmin, async (req, res) => {
    try {
        const [users] = await db.query('SELECT id, name, email, role, delegate_id FROM users ORDER BY id DESC');
        res.json({ success: true, data: users });
    } catch (error) {
        res.status(500).json({ success: false, error: '資料庫讀取失敗' });
    }
});

router.post('/', requireAdmin, async (req, res) => {
    const { name, email, password, role, delegate_id } = req.body;
    const delegateId = delegate_id ? delegate_id : null;
    try {
        await db.query(
            'INSERT INTO users (name, email, password_hash, role, delegate_id) VALUES (?, ?, ?, ?, ?)',
            [name, email, password, role, delegateId]
        );
        res.json({ success: true, message: '使用者新增成功' });
    } catch (error) {
        res.status(500).json({ success: false, error: '新增失敗，請確認該信箱是否已存在' });
    }
});

router.put('/:id', requireAdmin, async (req, res) => {
    const userId = req.params.id;
    const { name, email, password, role, delegate_id } = req.body;
    const delegateId = delegate_id ? delegate_id : null;
    try {
        if (password) {
            await db.query(
                'UPDATE users SET name = ?, email = ?, password_hash = ?, role = ?, delegate_id = ? WHERE id = ?',
                [name, email, password, role, delegateId, userId]
            );
        } else {
            await db.query(
                'UPDATE users SET name = ?, email = ?, role = ?, delegate_id = ? WHERE id = ?',
                [name, email, role, delegateId, userId]
            );
        }
        res.json({ success: true, message: '資料更新成功' });
    } catch (error) {
        res.status(500).json({ success: false, error: '系統更新失敗' });
    }
});

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
