import express from 'express'
import cors from 'cors'
import { open } from 'sqlite'
import sqlite3 from 'sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(
  cors({
    origin: '*', // 部署初期可以先開 * 允許所有人，比較不會因為 CORS 報錯
  }),
)
app.use(express.json())

let db

  // 初始化資料庫
;(async () => {
  db = await open({
    filename: path.join(__dirname, 'database.db'),
    driver: sqlite3.Database,
  })

  // ⚠️ 重大提醒：SQLite 預設不會啟用外鍵功能，必須在連線後「強制開啟」它！
  await db.exec('PRAGMA foreign_keys = ON;')

  // 建立資料表
  await db.exec(`
    -- 1. 期別表 (主表)
    CREATE TABLE IF NOT EXISTS periods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 2. 品項表 (加上對 periods 的外鍵與級聯刪除)
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_id INTEGER,
      code TEXT,
      name TEXT,
      unit TEXT,
      type TEXT,
      pack TEXT,
      FOREIGN KEY (period_id) REFERENCES periods(id) ON DELETE CASCADE
    );

    -- 3. 據點表 (加上對 periods 的外鍵與級聯刪除)
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_id INTEGER,
      name TEXT,
      status_firstBox INTEGER,
      FOREIGN KEY (period_id) REFERENCES periods(id) ON DELETE CASCADE
    );

    -- 4. 庫存狀態明細表 (加上對 periods、items、locations 的外鍵與級聯刪除)
    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  console.log('Database & Tables created with Foreign Keys!')
})()

// 新增期別
app.post('/api/periods/add', async (req, res) => {
  const { periodName } = req.body

  if (!periodName) {
    return res.status(400).json({ success: false, message: '請提供期別名稱' })
  }

  try {
    const periodResult = await db.run('INSERT INTO periods (name) VALUES (?)', [periodName])
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
  // 1. 改為接收前端傳入的 periodId 與 data 陣列
  const { periodId, data } = req.body

  if (!periodId || !data || !Array.isArray(data)) {
    return res.status(400).json({ success: false, message: '資料格式錯誤或缺少期別ID' })
  }

  try {
    // 建議：在大量寫入前，同樣確保 SQLite 外鍵功能開啟
    await db.run('PRAGMA foreign_keys = ON;')

    // 2. 開始跑品項迴圈
    for (const row of data) {
      // 🌟【品項檢查】：檢查該期別下是否已存在相同 code 的品項
      let item = await db.get('SELECT id FROM items WHERE period_id = ? AND code = ?', [
        periodId,
        row['code'],
      ])

      let itemId
      if (!item) {
        // 如果不存在，才新增品項
        const itemResult = await db.run(
          'INSERT INTO items (period_id, code, name, unit, type, pack) VALUES (?, ?, ?, ?, ?, ?)',
          [periodId, row['code'], row['name'], row['unit'], row['type'], row['pack']],
        )
        itemId = itemResult.lastID
      } else {
        // 如果已存在，跳過新增，直接拿既有的 id 繼續做後續的據點與明細處理
        itemId = item.id
      }

      // 3. 動態跑據點欄位
      for (const [key, value] of Object.entries(row)) {
        if (key === 'code' || key === 'name' || key === 'unit' || key === 'type' || key === 'pack')
          continue
        // if (value === null || value === undefined) continue // 排除空數值
        let targetValue = value === null || value === undefined ? 0 : value
        let targetStatus = targetValue === 0 ? 1 : 0

        // 🌟【據點檢查】：檢查該期別下是否已存在相同 name 的據點
        let location = await db.get('SELECT id FROM locations WHERE period_id = ? AND name = ?', [
          periodId,
          key,
        ])

        let locationId
        if (!location) {
          // 如果不存在，才新增據點
          const locResult = await db.run(
            'INSERT INTO locations (period_id, name, status_firstBox) VALUES (?, ?, ?)',
            [periodId, key, 0],
          )
          locationId = locResult.lastID
        } else {
          // 如果已存在，跳過新增，直接拿既有的 id
          locationId = location.id
        }

        // 🌟【庫存明細檢查與寫入】：
        // 為了避免重複匯入時明細爆炸，這裡通常也建議檢查「此期別+此品項+此據點」是否已建過明細
        const existingRecord = await db.get(
          'SELECT id FROM records WHERE period_id = ? AND item_id = ? AND location_id = ?',
          [periodId, itemId, locationId],
        )

        if (!existingRecord) {
          // 只有沒建立過明細，才寫入明細表
          await db.run(
            `INSERT INTO records
             (period_id, item_id, location_id, quantity, status)
             VALUES (?, ?, ?, ?, ?)`,
            [periodId, itemId, locationId, targetValue, targetStatus],
          )
        } else {
          // 可選：如果明細已存在，看你要「跳過」還是「更新目標數量」
          // 如果要更新數量，可以解開下一行：
          await db.run('UPDATE records SET quantity = ?, status = ? WHERE id = ?', [
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
    // 從 POST 的 body 中取出 id
    const { id } = req.body

    let sql = 'SELECT id, name, created_at FROM periods'
    const params = []

    // 如果有傳入 id，就加入 WHERE 條件
    if (id !== undefined && id !== null && id !== '') {
      sql += ' WHERE id = ?'
      params.push(id)
    }

    // 無論有沒有條件，最後都依據 id 降冪排列（最新的在最上面）
    sql += ' ORDER BY id DESC'

    // 執行查詢
    const rows = await db.all(sql, params)

    res.json({
      success: true,
      data: rows,
    })
  } catch (err) {
    console.error('撈取期別清單失敗:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

// 刪除期別
app.delete('/api/periods/delete/:id', async (req, res) => {
  const periodId = req.params.id

  try {
    // ⚠️ 關鍵：每次請求或連線，都要確保 SQLite 的外鍵功能是開啟的
    // (如果你在連線池/全域已經設定過，這邊可以省略，但保險起見加上不吃虧)
    await db.run('PRAGMA foreign_keys = ON;')

    // 執行刪除主表（期別表）的動作
    const result = await db.run('DELETE FROM periods WHERE id = ?', [periodId])

    // changes 代表受影響（被刪除）的資料筆數
    if (result.changes === 0) {
      return res.status(404).json({
        success: false,
        message: '找不到該期別，無法刪除',
      })
    }

    // 成功刪除
    return res.status(200).json({
      success: true,
      message: '期別及所有關聯的品項、據點、庫存明細已成功一併刪除！',
    })
  } catch (error) {
    console.error('刪除期別時發生錯誤:', error)
    return res.status(500).json({
      success: false,
      message: '伺服器錯誤，刪除失敗',
    })
  }
})

// 查詢某期品項
app.post('/api/items/get', async (req, res) => {
  const { periodId, itemId } = req.body

  // 防呆：沒有傳 periodId 就直接擋掉
  if (periodId === undefined || periodId === null || periodId === '') {
    return res.status(400).json({ success: false, message: '缺少必填的 periodId' })
  }

  try {
    // 🌟 核心改寫：利用 LEFT JOIN 撈取明細，並用 CASE WHEN 判斷是否「全部明細的 status 都是 1」
    let sql = `
      SELECT
        i.id,
        i.code,
        i.name,
        i.unit,
        i.type,
        i.pack,

        -- 🌟 統計 quantity 總數
        -- COALESCE 的作用是防呆，如果這筆品項在 records 裡完全沒有明細（加總出來是 NULL），就自動轉成 0
        IFNULL(SUM(r.quantity), 0) AS total,

        -- 🎯 關鍵邏輯：
        -- 1. COUNT(r.id) = 0 代表這筆品項在 records 裡根本沒有任何明細，預設給 0
        -- 2. MIN(r.status) = 1 代表這筆品項在 records 裡的所有明細「最小的值也是 1」（即全為 1）
        CASE
          WHEN COUNT(r.id) > 0 AND MIN(r.status) = 1 THEN 1
          ELSE 0
        END AS status
      FROM items i
      LEFT JOIN records r ON i.id = r.item_id AND i.period_id = r.period_id
      WHERE i.period_id = ?
    `

    const params = [periodId]

    // 如果有傳 itemId，動態加入過濾條件
    if (itemId !== undefined && itemId !== null && itemId !== '') {
      sql += ' AND i.id = ?'
      params.push(itemId)
    }

    // 🌟 因為用了 LEFT JOIN 與聚合函數 (MIN, COUNT)，SQL 語法規定必須加上 GROUP BY 進行分組
    sql += ' GROUP BY i.id ORDER BY i.id ASC'

    const rows = await db.all(sql, params)

    res.json({
      success: true,
      data: rows,
    })
  } catch (err) {
    console.error('撈取品項失敗:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

// 修改某期品項
app.put('/api/items/edit', async (req, res) => {
  // 1. 解構賦值：必傳的 id 抽出來，其餘欄位打包進 updateFields
  const { id, ...updateFields } = req.body

  // 防呆：如果沒傳 id，直接拒絕
  if (id === undefined || id === null || id === '') {
    return res.status(400).json({ success: false, message: '缺少必填的品項 ID' })
  }

  // 2. 特殊欄位處理：不論前端傳物件還是字串，通通安全相容
  if (updateFields.pack !== undefined) {
    if (typeof updateFields.pack === 'object' && updateFields.pack !== null) {
      // 💡 如果前端傳的是物件，後端幫忙轉字串
      updateFields.pack = JSON.stringify(updateFields.pack)
    }
    // 如果 typeof 是 'string'，代表前端已經轉好了，這裡就直接放行，不做任何處理！
  }

  // 3. 取得所有要修改的欄位名稱
  const keys = Object.keys(updateFields)

  // 防呆：如果只傳了 id，但沒有傳任何其他要修改的欄位
  if (keys.length === 0) {
    return res.status(400).json({ success: false, message: '請提供至少一個要修改的欄位' })
  }

  try {
    // 4. 動態組合 SQL 的 SET 語句 (例如: "name = ?, unit = ?")
    const setClause = keys.map((key) => `${key} = ?`).join(', ')

    // 5. 動態組合參數陣列
    const params = keys.map((key) => updateFields[key])
    params.push(id) // WHERE id = ? 的這個 id 永遠坐最後一個位子

    // 最終 SQL： UPDATE items SET name = ?, unit = ? WHERE id = ?
    const sql = `UPDATE items SET ${setClause} WHERE id = ?`

    // 印出 Log 方便你後台排查
    console.log('【執行 items 動態更新 SQL】:', sql)
    console.log('【執行 items 動態更新參數】:', params)

    // 6. 執行更新
    const result = await db.run(sql, params)

    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: '找不到該商品品項，修改失敗' })
    }

    res.json({
      success: true,
      message: '品項資料修改成功！',
    })
  } catch (err) {
    console.error('修改品項失敗:', err)
    res.status(500).json({ success: false, error: '修改失敗，請檢查欄位名稱是否正確' })
  }
})

// 查詢某期據點
app.post('/api/locations/get', async (req, res) => {
  const { periodId, locationId } = req.body

  // 防呆：沒有傳 periodId 就直接擋掉
  if (periodId === undefined || periodId === null || periodId === '') {
    return res.status(400).json({ success: false, message: '缺少必填的 periodId' })
  }

  try {
    // 🌟 核心改寫：利用 LEFT JOIN 撈取明細，並用 CASE WHEN 判斷是否「全部明細的 status 都是 1」
    let sql = `
      SELECT
        i.id,
        i.name,
        i.status_firstBox,
        -- 🎯 關鍵邏輯：
        -- 1. COUNT(r.id) = 0 代表這筆品項在 records 裡根本沒有任何明細，預設給 0
        -- 2. MIN(r.status) = 1 代表這筆品項在 records 裡的所有明細「最小的值也是 1」（即全為 1）
        CASE
          WHEN COUNT(r.id) > 0 AND MIN(r.status) = 1 THEN 1
          ELSE 0
        END AS status
      FROM locations i
      LEFT JOIN records r ON i.id = r.location_id AND i.period_id = r.period_id
      WHERE i.period_id = ?
    `

    const params = [periodId]

    // 如果有傳 itemId，動態加入過濾條件
    if (locationId !== undefined && locationId !== null && locationId !== '') {
      sql += ' AND i.id = ?'
      params.push(locationId)
    }

    // 🌟 因為用了 LEFT JOIN 與聚合函數 (MIN, COUNT)，SQL 語法規定必須加上 GROUP BY 進行分組
    sql += ' GROUP BY i.id ORDER BY i.id ASC'

    const rows = await db.all(sql, params)

    res.json({
      success: true,
      data: rows,
    })
  } catch (err) {
    console.error('撈取據點失敗:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

// 修改某期據點
app.put('/api/locations/edit', async (req, res) => {
  // 1. 解構賦值：必傳的 id 抽出來，其餘欄位打包進 updateFields
  const { id, ...updateFields } = req.body

  // 防呆：如果沒傳 id，直接拒絕
  if (id === undefined || id === null || id === '') {
    return res.status(400).json({ success: false, message: '缺少必填的據點 ID' })
  }

  // 2. 取得所有要修改的欄位名稱
  const keys = Object.keys(updateFields)

  // 防呆：如果只傳了 id，但沒有傳任何其他要修改的欄位
  if (keys.length === 0) {
    return res.status(400).json({ success: false, message: '請提供至少一個要修改的欄位' })
  }

  try {
    // 4. 動態組合 SQL 的 SET 語句 (例如: "name = ?, status_firstBox = ?")
    const setClause = keys.map((key) => `${key} = ?`).join(', ')

    // 5. 動態組合參數陣列
    const params = keys.map((key) => updateFields[key])
    params.push(id) // WHERE id = ? 的這個 id 永遠坐最後一個位子

    // 最終 SQL： UPDATE locations SET name = ?, status_firstBox = ? WHERE id = ?
    const sql = `UPDATE locations SET ${setClause} WHERE id = ?`

    // 印出 Log 方便你後台排查
    console.log('【執行 locations 動態更新 SQL】:', sql)
    console.log('【執行 locations 動態更新參數】:', params)

    // 6. 執行更新
    const result = await db.run(sql, params)

    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: '找不到該商品據點，修改失敗' })
    }

    res.json({
      success: true,
      message: '據點資料修改成功！',
    })
  } catch (err) {
    console.error('修改據點失敗:', err)
    res.status(500).json({ success: false, error: '修改失敗，請檢查欄位名稱是否正確' })
  }
})

// 查詢品項&據點明細
app.post('/api/records/search', async (req, res) => {
  // 1. 改從 req.body 拿取參數
  const { periodId, itemId, locationId } = req.body

  // 🛡️ 防呆第一線：檢查必填的 periodId
  if (periodId === undefined || periodId === null || periodId === '') {
    return res.status(400).json({ success: false, message: '缺少必填的 periodId' })
  }

  // 🛡️ 防呆第二線：檢查 itemId 與 locationId 是否「至少傳了其中一個」
  const hasItemId = itemId !== undefined && itemId !== null && itemId !== ''
  const hasLocationId = locationId !== undefined && locationId !== null && locationId !== ''

  if (!hasItemId && !hasLocationId) {
    return res.status(400).json({
      success: false,
      message: 'itemId 或 locationId 必須至少提供其中一個欄位進行查詢',
    })
  }

  try {
    // 2. 基礎 SQL 語句： period_id 一定有，所以直接放進 WHERE
    let sql = `
      SELECT
        r.id AS record_id,
        i.code,
        i.name AS item_name,
        i.type,
        l.name AS location_name,
        l.status_firstBox,
        r.item_id,
        r.location_id,
        r.quantity,
        r.status
      FROM records r
      JOIN items i ON r.item_id = i.id
      JOIN locations l ON r.location_id = l.id
      WHERE r.period_id = ?
    `
    // 預處理參數陣列，第一個放必定存在的 periodId
    const params = [periodId]

    // 3. 🐍 動態拼接 itemId 條件
    if (hasItemId) {
      sql += ' AND r.item_id = ?'
      params.push(itemId)
    }

    // 4. 🐍 動態拼接 locationId 條件
    if (hasLocationId) {
      sql += ' AND r.location_id = ?'
      params.push(locationId)
    }

    // 加上排序讓前端表格呈現更整齊（可選）
    sql += ' ORDER BY r.id ASC'

    // 5. 執行安全查詢
    const rows = await db.all(sql, params)

    res.json({
      success: true,
      data: rows,
    })
  } catch (err) {
    console.error('動態查詢明細失敗:', err)
    res.status(500).json({ success: false, error: err.message })
  }
})

// 修改品項&據點明細
app.put('/api/records/edit', async (req, res) => {
  // 1. 必傳的 id (明細表的 id)
  const { id, ...updateFields } = req.body

  // 防呆：如果沒傳 id，直接拒絕
  if (id === undefined || id === null || id === '') {
    return res.status(400).json({ success: false, message: '缺少必填的明細 ID' })
  }

  // 2. 取得要動態修改的欄位名稱
  const keys = Object.keys(updateFields)

  // 防呆：如果只傳了 id，但沒有傳任何其他要修改的欄位
  if (keys.length === 0) {
    return res.status(400).json({ success: false, message: '請提供至少一個要修改的欄位' })
  }

  try {
    // 3. 動態組合 SQL 的 SET 語句
    // 例如：['quantity = ?', 'status = ?']
    const setClause = keys.map((key) => `${key} = ?`).join(', ')

    // 4. 動態組合參數陣列
    // 把要更新的值依序放進去，最後「一定要」把用來當 WHERE 條件的 id 放最後面
    const params = keys.map((key) => updateFields[key])
    params.push(id) // WHERE id = ? 的這個 id 坐最後一個位子

    // 最終 SQL 會長這樣： UPDATE records SET quantity = ?, status = ? WHERE id = ?
    const sql = `UPDATE records SET ${setClause} WHERE id = ?`

    // 印出 Log 方便你除錯
    console.log('【執行動態更新 SQL】:', sql)
    console.log('【執行動態更新參數】:', params)

    // 5. 執行更新
    const result = await db.run(sql, params)

    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: '找不到該筆明細資料，修改失敗' })
    }

    res.json({
      success: true,
      message: '明細資料修改成功！',
    })
  } catch (err) {
    console.error('修改明細失敗:', err)
    // 如果前端傳了資料表沒有的欄位名稱，SQLite 會在這裡噴錯，直接抓進 catch 裡
    res.status(500).json({ success: false, error: '修改失敗，請檢查欄位名稱是否正確' })
  }
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`伺服器成功運行在 Port ${PORT}`)
})
