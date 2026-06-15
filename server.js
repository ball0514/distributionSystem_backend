import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
// 引入 PostgreSQL 驅動
import pg from 'pg'
const { Pool } = pg

// 保留 SQLite 作為本地相容方案
// import { open } from 'sqlite'
// import sqlite3 from 'sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()

app.use(
  cors({
    origin: '*',
  }),
)
app.use(express.json())

// 統一的資料庫操作接口
let isPostgres = false
let pgPool = null // PostgreSQL 連線池
let sqliteDb = null // SQLite 連線物件

// 統一的資料庫操作接口
const dbQuery = {
  // 1. 查詢多筆
  all: async (sql, params = []) => {
    if (isPostgres) {
      let count = 0
      const pgSql = sql.replace(/\?/g, () => {
        count++
        return `$${count}` // 依序把問號替換成 $1, $2, $3...
      })
      const res = await pgPool.query(pgSql, params)
      return res.rows
    } else {
      return await sqliteDb.all(sql, params)
    }
  },

  // 2. 查詢單筆
  get: async (sql, params = []) => {
    if (isPostgres) {
      let count = 0
      const pgSql = sql.replace(/\?/g, () => {
        count++
        return `$${count}`
      })
      const res = await pgPool.query(pgSql, params)
      return res.rows[0] || null
    } else {
      return await sqliteDb.get(sql, params)
    }
  },

  // 3. 執行修改/新增/刪除
  run: async (sql, params = []) => {
    if (isPostgres) {
      let count = 0
      let pgSql = sql.replace(/\?/g, () => {
        count++
        return `$${count}`
      })
      
      const isInsert = pgSql.trim().toUpperCase().startsWith('INSERT')
      if (isInsert) {
        pgSql += ' RETURNING id'
      }

      const res = await pgPool.query(pgSql, params)
      return {
        changes: res.rowCount,
        lastID: isInsert && res.rows[0] ? res.rows[0].id : null
      }
    } else {
      return await sqliteDb.run(sql, params)
    }
  },

  // 執行純 SQL 腳本
  exec: async (sql) => {
    if (isPostgres) {
      await pgPool.query(sql)
    } else {
      await sqliteDb.exec(sql)
    }
  }
}

// 初始化資料庫
;(async () => {
  // 🎯 判斷依據：如果環境變數有 DATABASE_URL，就代表在 Render 線上環境，走 Neon 
  if (process.env.DATABASE_URL) {
    console.log('--- 🚀 偵測到環境變數，啟用 Neon PostgreSQL 模式 ---')
    isPostgres = true
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false } // Neon 強制要求加密連線
    })
  } else {
    console.log('--- 💻 未偵測到環境變數，啟用本地 SQLite 模式 ---')
    isPostgres = false

    const { open } = await import('sqlite')
    const sqlite3 = (await import('sqlite3')).default
    
    sqliteDb = await open({
      filename: path.join(__dirname, 'database.db'),
      driver: sqlite3.Database,
    })
    // SQLite 必須強制開啟外鍵
    await sqliteDb.exec('PRAGMA foreign_keys = ON;')
  }

  // 建立資料表 (語法相容 PostgreSQL 與 SQLite)
  // 將 SQLite 的 AUTOINCREMENT 改為兩者相容的 SERIAL 或在 SQLite 自動轉型為自增
  const idType = isPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'
  
  await dbQuery.exec(`
    -- 1. 期別表
    CREATE TABLE IF NOT EXISTS periods (
      id ${idType},
      name TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- 2. 品項表
    CREATE TABLE IF NOT EXISTS items (
      id ${idType},
      period_id INTEGER,
      code TEXT,
      name TEXT,
      unit TEXT,
      type TEXT,
      pack TEXT,
      FOREIGN KEY (period_id) REFERENCES periods(id) ON DELETE CASCADE
    );

    -- 3. 據點表
    CREATE TABLE IF NOT EXISTS locations (
      id ${idType},
      period_id INTEGER,
      name TEXT,
      status_firstBox INTEGER,
      FOREIGN KEY (period_id) REFERENCES periods(id) ON DELETE CASCADE
    );

    -- 4. 庫存狀態明細表
    CREATE TABLE IF NOT EXISTS records (
      id ${idType},
      period_id INTEGER,
      item_id INTEGER,
      location_id INTEGER,
      quantity INTEGER DEFAULT 0,
      status INTEGER DEFAULT 0,
      FOREIGN KEY (period_id) REFERENCES periods(id) ON DELETE CASCADE,
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
      FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE
    );
  `)
  console.log('Database & Tables initialized successfully!')
})()

// 新增期別
app.post('/api/periods/add', async (req, res) => {
  const { periodName } = req.body
  if (!periodName) {
    return res.status(400).json({ success: false, message: '請提供期別名稱' })
  }
  try {
    const periodResult = await dbQuery.run('INSERT INTO periods (name) VALUES (?)', [periodName])
    const periodId = periodResult.lastID

    res.json({
      success: true,
      message: `期別「${periodName}」建立成功！`,
      periodId,
    })
  } catch (err) {
    console.error('建立期別失敗:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

// 修改期別，匯入清單
app.post('/api/periods/edit', async (req, res) => {
  const { periodId, data } = req.body
  if (!periodId || !data || !Array.isArray(data)) {
    return res.status(400).json({ success: false, message: '資料格式錯誤或缺少期別ID' })
  }

  try {
    for (const row of data) {
      let item = await dbQuery.get('SELECT id FROM items WHERE period_id = ? AND code = ?', [
        periodId,
        row['code'],
      ])

      let itemId
      if (!item) {
        const itemResult = await dbQuery.run(
          'INSERT INTO items (period_id, code, name, unit, type, pack) VALUES (?, ?, ?, ?, ?, ?)',
          [periodId, row['code'], row['name'], row['unit'], row['type'], row['pack']],
        )
        itemId = itemResult.lastID
      } else {
        itemId = item.id
      }

      for (const [key, value] of Object.entries(row)) {
        if (key === 'code' || key === 'name' || key === 'unit' || key === 'type' || key === 'pack')
          continue
        let targetValue = value === null || value === undefined ? 0 : value
        let targetStatus = targetValue === 0 ? 1 : 0

        let location = await dbQuery.get('SELECT id FROM locations WHERE period_id = ? AND name = ?', [
          periodId,
          key,
        ])

        let locationId
        if (!location) {
          const locResult = await dbQuery.run(
            'INSERT INTO locations (period_id, name, status_firstBox) VALUES (?, ?, ?)',
            [periodId, key, 0],
          )
          locationId = locResult.lastID
        } else {
          locationId = location.id
        }

        const existingRecord = await dbQuery.get(
          'SELECT id FROM records WHERE period_id = ? AND item_id = ? AND location_id = ?',
          [periodId, itemId, locationId],
        )

        if (!existingRecord) {
          await dbQuery.run(
            `INSERT INTO records (period_id, item_id, location_id, quantity, status) VALUES (?, ?, ?, ?, ?)`,
            [periodId, itemId, locationId, targetValue, targetStatus],
          )
        } else {
          await dbQuery.run('UPDATE records SET quantity = ?, status = ? WHERE id = ?', [
            targetValue,
            targetStatus,
            existingRecord.id,
          ])
        }
      }
    }
    res.json({ success: true, message: '資料比對並匯入完成！', periodId })
  } catch (err) {
    console.error('匯入失敗:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

// 查詢期別
app.post('/api/periods/get', async (req, res) => {
  try {
    const { id } = req.body
    let sql = 'SELECT id, name, created_at FROM periods'
    const params = []

    if (id !== undefined && id !== null && id !== '') {
      sql += ' WHERE id = ?'
      params.push(id)
    }
    sql += ' ORDER BY id DESC'

    const rows = await dbQuery.all(sql, params)
    res.json({ success: true, data: rows })
  } catch (err) {
    console.error('撈取期別清單失敗:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

// 刪除期別
app.delete('/api/periods/delete/:id', async (req, res) => {
  const periodId = req.params.id
  try {
    const result = await dbQuery.run('DELETE FROM periods WHERE id = ?', [periodId])
    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: '找不到該期別，無法刪除' })
    }
    return res.status(200).json({ success: true, message: '期別及所有關聯資料已成功一併刪除！' })
  } catch (error) {
    console.error('刪除期別時發生錯誤:', error)
    return res.status(500).json({ success: false, message: '伺服器錯誤，刪除失敗' })
  }
})

// 查詢某期品項
app.post('/api/items/get', async (req, res) => {
  const { periodId, itemId } = req.body
  if (periodId === undefined || periodId === null || periodId === '') {
    return res.status(400).json({ success: false, message: '缺少必填的 periodId' })
  }

  try {
    // 將 SQLite 的 IFNULL 改成 PostgreSQL 也看得懂的 COALESCE
    let sql = `
      SELECT
        i.id, i.code, i.name, i.unit, i.type, i.pack,
        COALESCE(SUM(r.quantity), 0) AS total,
        CASE
          WHEN COUNT(r.id) > 0 AND MIN(r.status) = 1 THEN 1
          ELSE 0
        END AS status
      FROM items i
      LEFT JOIN records r ON i.id = r.item_id AND i.period_id = r.period_id
      WHERE i.period_id = ?
    `
    const params = [periodId]
    if (itemId !== undefined && itemId !== null && itemId !== '') {
      sql += ' AND i.id = ?'
      params.push(itemId)
    }
    sql += ' GROUP BY i.id, i.code, i.name, i.unit, i.type, i.pack ORDER BY i.id ASC'

    const rows = await dbQuery.all(sql, params)
    res.json({ success: true, data: rows })
  } catch (err) {
    console.error('撈取品項失敗:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

// 修改某期品項
app.put('/api/items/edit', async (req, res) => {
  const { id, ...updateFields } = req.body
  if (id === undefined || id === null || id === '') {
    return res.status(400).json({ success: false, message: '缺少必填的品項 ID' })
  }
  if (updateFields.pack !== undefined && typeof updateFields.pack === 'object' && updateFields.pack !== null) {
    updateFields.pack = JSON.stringify(updateFields.pack)
  }

  const keys = Object.keys(updateFields)
  if (keys.length === 0) {
    return res.status(400).json({ success: false, message: '請提供至少一個要修改的欄位' })
  }

  try {
    const setClause = keys.map((key) => `${key} = ?`).join(', ')
    const params = keys.map((key) => updateFields[key])
    params.push(id)

    const sql = `UPDATE items SET ${setClause} WHERE id = ?`
    const result = await dbQuery.run(sql, params)

    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: '找不到該商品品項，修改失敗' })
    }
    res.json({ success: true, message: '品項資料修改成功！' })
  } catch (err) {
    console.error('修改品項失敗:', err)
    res.status(500).json({ success: false, error: '修改失敗，請檢查欄位名稱是否正確' })
  }
})

// 查詢某期據點
app.post('/api/locations/get', async (req, res) => {
  const { periodId, locationId } = req.body
  if (periodId === undefined || periodId === null || periodId === '') {
    return res.status(400).json({ success: false, message: '缺少必填的 periodId' })
  }

  try {
    let sql = `
      SELECT
        i.id, i.name, i.status_firstBox,
        CASE
          WHEN COUNT(r.id) > 0 AND MIN(r.status) = 1 THEN 1
          ELSE 0
        END AS status
      FROM locations i
      LEFT JOIN records r ON i.id = r.location_id AND i.period_id = r.period_id
      WHERE i.period_id = ?
    `
    const params = [periodId]
    if (locationId !== undefined && locationId !== null && locationId !== '') {
      sql += ' AND i.id = ?'
      params.push(locationId)
    }
    sql += ' GROUP BY i.id, i.name, i.status_firstBox ORDER BY i.id ASC'

    const rows = await dbQuery.all(sql, params)
    res.json({ success: true, data: rows })
  } catch (err) {
    console.error('撈取據點失敗:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

// 修改某期據點
app.put('/api/locations/edit', async (req, res) => {
  const { id, ...updateFields } = req.body
  if (id === undefined || id === null || id === '') {
    return res.status(400).json({ success: false, message: '缺少必填的據點 ID' })
  }
  const keys = Object.keys(updateFields)
  if (keys.length === 0) {
    return res.status(400).json({ success: false, message: '請提供至少一個要修改的欄位' })
  }

  try {
    const setClause = keys.map((key) => `${key} = ?`).join(', ')
    const params = keys.map((key) => updateFields[key])
    params.push(id)

    const sql = `UPDATE locations SET ${setClause} WHERE id = ?`
    const result = await dbQuery.run(sql, params)

    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: '找不到該商品據點，修改失敗' })
    }
    res.json({ success: true, message: '據點資料修改成功！' })
  } catch (err) {
    console.error('修改據點失敗:', err)
    res.status(500).json({ success: false, error: '修改失敗，請檢查欄位名稱是否正確' })
  }
})

// 查詢品項&據點明細
app.post('/api/records/search', async (req, res) => {
  const { periodId, itemId, locationId } = req.body
  if (periodId === undefined || periodId === null || periodId === '') {
    return res.status(400).json({ success: false, message: '缺少必填的 periodId' })
  }

  const hasItemId = itemId !== undefined && itemId !== null && itemId !== ''
  const hasLocationId = locationId !== undefined && locationId !== null && locationId !== ''
  if (!hasItemId && !hasLocationId) {
    return res.status(400).json({ success: false, message: 'itemId 或 locationId 必須至少提供其中一個欄位' })
  }

  try {
    let sql = `
      SELECT
        r.id AS record_id, i.code, i.name AS item_name, i.type,
        l.name AS location_name, l.status_firstBox,
        r.item_id, r.location_id, r.quantity, r.status
      FROM records r
      JOIN items i ON r.item_id = i.id
      JOIN locations l ON r.location_id = l.id
      WHERE r.period_id = ?
    `
    const params = [periodId]
    if (hasItemId) {
      sql += ' AND r.item_id = ?'
      params.push(itemId)
    }
    if (hasLocationId) {
      sql += ' AND r.location_id = ?'
      params.push(locationId)
    }
    sql += ' ORDER BY r.id ASC'

    const rows = await dbQuery.all(sql, params)
    res.json({ success: true, data: rows })
  } catch (err) {
    console.error('動態查詢明細失敗:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

// 修改品項&據點明細
app.put('/api/records/edit', async (req, res) => {
  const { id, ...updateFields } = req.body
  if (id === undefined || id === null || id === '') {
    return res.status(400).json({ success: false, message: '缺少必填的明細 ID' })
  }
  const keys = Object.keys(updateFields)
  if (keys.length === 0) {
    return res.status(400).json({ success: false, message: '請提供至少一個要修改的欄位' })
  }

  try {
    const setClause = keys.map((key) => `${key} = ?`).join(', ')
    const params = keys.map((key) => updateFields[key])
    params.push(id)

    const sql = `UPDATE records SET ${setClause} WHERE id = ?`
    const result = await dbQuery.run(sql, params)

    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: '找不到該筆明細資料，修改失敗' })
    }
    res.json({ success: true, message: '明細資料修改成功！' })
  } catch (err) {
    console.error('修改明細失敗:', err)
    res.status(500).json({ success: false, error: '修改失敗，請檢查欄位名稱是否正確' })
  }
})

// 🌟 確保監聽 Render 給的動態 Port
const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`伺服器成功運行在 Port ${PORT}`)
})