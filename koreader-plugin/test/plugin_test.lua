--[[
ReadSync KOReader 插件的自动推送逻辑测试。

KOReader 插件平时只能靠人眼读代码 —— 没有真机就没法验证「每 N 页推一次」
到底是不是每 N 页推一次。这里用一套 KOReader 模块桩把插件加载起来，
直接驱动事件回调并断言推送次数。

跑法（仓库根目录）：
  npm run test:plugin

原理：用 fengari（JS 里的 Lua 虚拟机）加载插件，把 datastorage / uimanager /
network/manager 等 KOReader 模块换成桩，然后直接驱动 onPageUpdate / 定时器回调，
断言「每 N 页推一次」确实每 N 页推一次、没 Wi-Fi 时跳过的页不会白数。

注意：KOReader 跑的是 LuaJIT（5.1），这里是 Lua 5.3。插件只用两者都支持的
写法，所以语义一致；纯 5.1 的语法问题仍由 package.sh 里的 luac -p 兜底。
--]]

-- 插件目录由 runner 通过全局 ARG 传进来（dofile 的 ... 拿不到命令行参数）
local PLUGIN_DIR = ARG
if type(PLUGIN_DIR) ~= "string" or PLUGIN_DIR == "" then PLUGIN_DIR = "." end

local pushed = {}          -- 每次推送记录一条，供断言
local scheduled = {}       -- UIManager 的定时队列
local wifi_on = true
local clock = 1000
local menu_table = nil

-- ---------------------------------------------------------------------------
-- KOReader 模块桩
-- ---------------------------------------------------------------------------

local WidgetContainer = {}
function WidgetContainer:extend(subclass)
    subclass = subclass or {}
    setmetatable(subclass, { __index = self })
    return subclass
end
function WidgetContainer:new(o)
    o = o or {}
    setmetatable(o, { __index = self })
    return o
end

package.preload["ui/widget/container/widgetcontainer"] = function() return WidgetContainer end
package.preload["datastorage"] = function()
    return { getSettingsDir = function() return "/tmp" end }
end
package.preload["device"] = function() return { model = "TestDevice" } end
package.preload["ui/event"] = function()
    return { new = function(_, name) return { handler = name } end }
end
package.preload["ui/widget/infomessage"] = function() return { new = function() return {} end } end
package.preload["ui/widget/inputdialog"] = function() return { new = function() return {} end } end
package.preload["ui/widget/notification"] = function() return { new = function() return {} end } end
package.preload["luasettings"] = function()
    return {
        open = function()
            return {
                readSetting = function(_, _, default) return default end,
                saveSetting = function() end,
                flush = function() end,
            }
        end,
    }
end
package.preload["ui/network/manager"] = function()
    return {
        isWifiOn = function() return wifi_on end,
        isConnected = function() return true end,
        runWhenOnline = function(_, fn) fn() end,
    }
end
package.preload["ui/uimanager"] = function()
    return {
        show = function() end,
        scheduleIn = function(_, seconds, fn)
            local item = { seconds = seconds, fn = fn }
            table.insert(scheduled, item)
            return item
        end,
        unschedule = function(_, item)
            for i, v in ipairs(scheduled) do
                if v == item then table.remove(scheduled, i) break end
            end
        end,
    }
end
package.preload["logger"] = function()
    return { dbg = function() end, warn = function() end, err = function() end }
end
package.preload["ffi/sha2"] = function()
    return { md5 = function(s) return "md5:" .. tostring(s) end }
end
package.preload["util"] = function()
    return { splitFilePathName = function(p) return "/tmp/", "book.epub" end }
end
package.preload["gettext"] = function()
    return function(s) return s end
end
package.preload["ReadSyncClient"] = function()
    return { push = function() return { ok = true } end, pull = function() return nil end }
end

-- gettext 是直接 require("gettext") 后当函数用的，这里包一层上面的桩
package.preload["gettext"] = function()
    return setmetatable({}, { __call = function(_, s) return s end })
end

-- os.time 需要可控：分钟档的判定依赖它
local real_time = os.time
os.time = function() return clock end

-- ---------------------------------------------------------------------------
-- 加载插件
-- ---------------------------------------------------------------------------

local chunk = assert(loadfile(PLUGIN_DIR .. "/main.lua"))
local ReadSync = chunk()

-- 每次跑测试都重新造一个插件实例，避免状态互相污染
local function new_plugin(settings)
    local plugin = ReadSync:new{}
    plugin.settings = {
        server = "https://example.com",
        token = "rs_test",
        device_name = "",
        auto_push = true,
        push_on_suspend = true,
        auto_push_pages = 0,
        auto_push_minutes = 0,
        wifi_only = false,
        send_reading_time = true,
    }
    for k, v in pairs(settings or {}) do plugin.settings[k] = v end
    plugin.settings_obj = { saveSetting = function() end, flush = function() end }
    plugin.ui = { menu = { registerToMainMenu = function() end }, doc_settings = {} }
    plugin.device_id = "dev-1"
    plugin.pages_since_push = 0
    return plugin
end

--- 手动触发下一个定时器。
-- 真实的 UIManager 触发后就把这一项丢掉了，桩里也要照做，
-- 否则「回调里重排了一个」会被误算成「有两个定时器在跑」
local function fire_next_timer()
    local item = table.remove(scheduled, 1)
    if not item then return false end
    item.fn()
    return true
end

local function reset_world()
    pushed = {}
    scheduled = {}
    wifi_on = true
    clock = 1000
end

-- ---------------------------------------------------------------------------
-- 断言
-- ---------------------------------------------------------------------------

local passed, failed = 0, 0
local function check(name, ok, detail)
    if ok then
        passed = passed + 1
        print("  + " .. name)
    else
        failed = failed + 1
        print("  X " .. name .. (detail and (" -> " .. tostring(detail)) or ""))
    end
end

-- ---------------------------------------------------------------------------
-- 用例
-- ---------------------------------------------------------------------------

print("每 N 页自动推送")
do
    reset_world()
    local p = new_plugin{ auto_push_pages = 5 }
    p.pushProgress = function(_, silent)
        table.insert(pushed, { silent = silent })
    end

    for i = 1, 4 do p:onPageUpdate(i) end
    check("未到阈值不推送", #pushed == 0, #pushed)

    p:onPageUpdate(5)
    check("第 5 页推送一次", #pushed == 1, #pushed)
    check("自动推送是静默的", pushed[1] and pushed[1].silent == true, pushed[1] and pushed[1].silent)

    for i = 6, 9 do p:onPageUpdate(i) end
    check("计数已归零，第 6~9 页不推", #pushed == 1, #pushed)
    p:onPageUpdate(10)
    check("第 10 页再推一次", #pushed == 2, #pushed)
end

print("关闭时不推送")
do
    reset_world()
    local p = new_plugin{ auto_push_pages = 0 }
    p.pushProgress = function() table.insert(pushed, {}) end
    for i = 1, 50 do p:onPageUpdate(i) end
    check("阈值为 0 时翻多少页都不推", #pushed == 0, #pushed)
end

print("仅 Wi-Fi")
do
    reset_world()
    wifi_on = false
    local p = new_plugin{ auto_push_pages = 2, wifi_only = true }
    p.pushProgress = function() table.insert(pushed, {}) end

    for i = 1, 10 do p:onPageUpdate(i) end
    check("没 Wi-Fi 时跳过推送", #pushed == 0, #pushed)

    -- 关键：跳过的那些页不能白数。恢复 Wi-Fi 后应当立刻补上
    wifi_on = true
    p:onPageUpdate(11)
    check("恢复 Wi-Fi 后补推一次（计数没被清零）", #pushed == 1, #pushed)
end

print("每隔 N 分钟")
do
    reset_world()
    local p = new_plugin{ auto_push_minutes = 10 }
    p.pushProgress = function() table.insert(pushed, {}) end
    p:onReaderReady()
    check("开启分钟档后排了定时器", #scheduled == 1, #scheduled)
    check("定时器周期是 60 秒", scheduled[1] and scheduled[1].seconds == 60, scheduled[1] and scheduled[1].seconds)

    -- 立刻触发一次：还不满 10 分钟，应当不推
    fire_next_timer()
    check("未满间隔时不推", #pushed == 0, #pushed)
    check("回调里重排了下一个定时器", #scheduled == 1, #scheduled)

    clock = clock + 601
    fire_next_timer()
    check("超过间隔后推一次", #pushed == 1, #pushed)

    clock = clock + 60
    fire_next_timer()
    check("再过一个 tick 不重复推", #pushed == 1, #pushed)
end

print("退出阅读时停表")
do
    reset_world()
    local p = new_plugin{ auto_push_minutes = 5 }
    p.pushProgress = function() table.insert(pushed, {}) end
    p.ui = { menu = { registerToMainMenu = function() end }, doc_settings = {} }
    p:onReaderReady()
    check("定时器已排", #scheduled == 1, #scheduled)
    p:onCloseDocument()
    check("关书后定时器被取消", #scheduled == 0, #scheduled)
    check("关书时仍会推送一次（auto_push 开着）", #pushed == 1, #pushed)
end

print("配置解析")
do
    reset_world()
    local p = new_plugin{}
    check("非数字当 0", p:parseCount("abc") == 0)
    check("负数当 0", p:parseCount("-3") == 0)
    check("小数向下取整", p:parseCount("7.9") == 7)
    check("过大有上限", p:parseCount("999999") == 10000)
    check("空值当 0", p:parseCount(nil) == 0)
end

print("菜单文案带当前值（Lua 的 or/and 优先级很容易写错）")
do
    reset_world()
    --- 取出两个数值项在菜单里的文案
    local function menu_texts(pages, minutes)
        local p = new_plugin{ auto_push_pages = pages, auto_push_minutes = minutes }
        local menu_items = {}
        p:addToMainMenu(menu_items)
        local items = menu_items.readsync.sub_item_table_func()
        local pages_text, minutes_text
        for _, item in ipairs(items) do
            if item.text and item.text:find("每读 N 页自动推送", 1, true) then pages_text = item.text end
            if item.text and item.text:find("每隔 N 分钟自动推送", 1, true) then minutes_text = item.text end
        end
        return pages_text, minutes_text
    end

    -- 断言的是「选对了哪个分支」，不是「文本里出现了某个数字」——
    -- 后者在 or/and 优先级写错时也会通过（数字被直接拼进了字符串）。
    -- 0 在 Lua 里是真值，所以 (x or 0) == 0 那个括号非加不可。
    local t1 = menu_texts(12, 0)
    check("非零时显示页数、不显示关闭", t1:find("12", 1, true) ~= nil and t1:find("关闭", 1, true) == nil, t1)
    local _, t2 = menu_texts(12, 0)
    check("零时显示「关闭」而不是 0", t2:find("关闭", 1, true) ~= nil and t2:find("（0", 1, true) == nil, t2)
    local t3 = menu_texts(0, 30)
    check("页数档为 0 时也显示关闭", t3:find("关闭", 1, true) ~= nil and t3:find("（0", 1, true) == nil, t3)
end

print("")
print(string.format("通过 %d 项，失败 %d 项", passed, failed))
if failed > 0 then os.exit(1) end
