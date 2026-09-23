--[[
ReadSync 同步插件（KOReader 端）。

把阅读进度同步到自建的 ReadSync 服务器，走服务端的「统一同步接口」
（/api/sync-- ，见仓库 docs/api-reference.md）。

与 KOReader 内置进度同步的区别：
  * 用访问令牌（rs_xxx）认证，不需要把密码的 md5 交给服务器；
  * 会一并上报阅读时长，服务端的统计图表因此能覆盖 KOReader；
  * 出错时给出可读的中文提示，而不是静默失败。

模块命名说明：KOReader 会把插件目录加入 package.path，因此同目录模块用
require("ReadSyncClient") 引用。注意**模块名是全局的**，所以文件名带了
ReadSync 前缀，避免与其它插件的同名文件冲突。
--]]

local DataStorage = require("datastorage")
local Device = require("device")
local Event = require("ui/event")
local InfoMessage = require("ui/widget/infomessage")
local InputDialog = require("ui/widget/inputdialog")
local LuaSettings = require("luasettings")
local NetworkMgr = require("ui/network/manager")
local Notification = require("ui/widget/notification")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local logger = require("logger")
local md5 = require("ffi/sha2").md5
local util = require("util")
local _ = require("gettext")

local Client = require("ReadSyncClient")

local ReadSync = WidgetContainer:extend{
    name = "readsync",
    is_doc_only = true,
    settings_file = DataStorage:getSettingsDir() .. "/readsync.lua",
    default_settings = {
        server = "",
        token = "",
        device_name = "",
        auto_push = true,          -- 关闭书籍时自动推送
        push_on_suspend = true,    -- 休眠时自动推送
        send_reading_time = true,  -- 上报阅读时长（供服务端统计）
    },
}

function ReadSync:init()
    local settings_obj = LuaSettings:open(self.settings_file)
    self.settings = settings_obj:readSetting("settings", self.default_settings)
    -- 逐项补齐默认值，便于后续新增配置项时旧配置文件仍可用
    for key, value in pairs(self.default_settings) do
        if self.settings[key] == nil then
            self.settings[key] = value
        end
    end
    self.settings_obj = settings_obj

    self.device_id = G_reader_settings:readSetting("device_id")
    self.session_started_at = nil

    if self.ui and self.ui.menu then
        self.ui.menu:registerToMainMenu(self)
    end

    logger.dbg("ReadSync: 插件已加载，服务器 =", self.settings.server or "(未设置)")
end

function ReadSync:saveSettings()
    self.settings_obj:saveSetting("settings", self.settings)
    self.settings_obj:flush()
end

function ReadSync:setSetting(key, value)
    self.settings[key] = value
    self:saveSettings()
end

-- ----------------------------------------------------------------------------
-- 菜单
-- ----------------------------------------------------------------------------

--- 当前是否已配置到可以同步的程度
function ReadSync:isConfigured()
    return (self.settings.server or "") ~= "" and (self.settings.token or "") ~= ""
end

function ReadSync:addToMainMenu(menu_items)
    menu_items.readsync = {
        text = _("ReadSync 同步"),
        sorting_hint = "tools",
        sub_item_table_func = function()
            return {
                {
                    text = _("服务器地址"),
                    help_text = _("例如 https://read.example.com:8443"),
                    keep_menu_open = true,
                    callback = function(touchmenu_instance)
                        self:showInputDialog(
                            _("ReadSync 服务器地址"),
                            "https://read.example.com:8443",
                            self.settings.server,
                            function(value)
                                self:setSetting("server", value)
                                if touchmenu_instance then touchmenu_instance:updateItems() end
                            end
                        )
                    end,
                },
                {
                    text = _("访问令牌"),
                    help_text = _("在 ReadSync 的「设置 → 同步账号」中创建，形如 rs_xxx"),
                    keep_menu_open = true,
                    callback = function(touchmenu_instance)
                        self:showInputDialog(
                            _("访问令牌"),
                            "rs_xxxxxxxx",
                            self.settings.token,
                            function(value)
                                self:setSetting("token", value)
                                if touchmenu_instance then touchmenu_instance:updateItems() end
                            end
                        )
                    end,
                },
                {
                    text = _("设备名称"),
                    help_text = _("留空则使用设备型号：") .. tostring(Device.model),
                    keep_menu_open = true,
                    callback = function(touchmenu_instance)
                        self:showInputDialog(
                            _("设备名称"),
                            tostring(Device.model),
                            self.settings.device_name,
                            function(value)
                                self:setSetting("device_name", value)
                                if touchmenu_instance then touchmenu_instance:updateItems() end
                            end
                        )
                    end,
                },
                {
                    text = _("测试连接"),
                    keep_menu_open = true,
                    callback = function()
                        self:testConnection()
                    end,
                },
                {
                    text = _("立即推送进度"),
                    enabled = self:isConfigured(),
                    callback = function()
                        self:pushProgress(false)
                    end,
                },
                {
                    text = _("拉取并跳转到远端进度"),
                    enabled = self:isConfigured(),
                    callback = function()
                        self:pullProgress()
                    end,
                },
                {
                    text = _("关闭书籍时自动推送"),
                    checked = self.settings.auto_push,
                    keep_menu_open = true,
                    callback = function(touchmenu_instance)
                        self:setSetting("auto_push", not self.settings.auto_push)
                        if touchmenu_instance then touchmenu_instance:updateItems() end
                    end,
                },
                {
                    text = _("休眠时自动推送"),
                    checked = self.settings.push_on_suspend,
                    keep_menu_open = true,
                    callback = function(touchmenu_instance)
                        self:setSetting("push_on_suspend", not self.settings.push_on_suspend)
                        if touchmenu_instance then touchmenu_instance:updateItems() end
                    end,
                },
                {
                    text = _("上报阅读时长"),
                    help_text = _("把本次阅读时长一并提交，服务端的统计图表会包含 KOReader"),
                    checked = self.settings.send_reading_time,
                    keep_menu_open = true,
                    callback = function(touchmenu_instance)
                        self:setSetting("send_reading_time", not self.settings.send_reading_time)
                        if touchmenu_instance then touchmenu_instance:updateItems() end
                    end,
                },
            }
        end,
    }
end

function ReadSync:showInputDialog(title, hint, current, on_confirm)
    local dialog
    dialog = InputDialog:new{
        title = title,
        input = current or "",
        input_hint = hint,
        buttons = {
            {
                {
                    text = _("取消"),
                    id = "close",
                    callback = function()
                        UIManager:close(dialog)
                    end,
                },
                {
                    text = _("确定"),
                    is_enter_default = true,
                    callback = function()
                        local value = dialog:getInputText()
                        UIManager:close(dialog)
                        on_confirm(value and value:gsub("%s+$", "") or "")
                    end,
                },
            },
        },
    }
    UIManager:show(dialog)
    dialog:onShowKeyboard()
end

-- ----------------------------------------------------------------------------
-- 提示
-- ----------------------------------------------------------------------------

local function notify(text)
    UIManager:show(Notification:new{ text = text, timeout = 2 })
end

local function show_message(text, timeout)
    UIManager:show(InfoMessage:new{ text = text, timeout = timeout })
end

-- ----------------------------------------------------------------------------
-- 进度读取
-- ----------------------------------------------------------------------------

--- 文档标识。
-- 优先用 KOReader 生成的 partial_md5_checksum —— 同一本书在不同设备上
-- 该值一致，因此可以跨设备对上；拿不到时退回文件名 md5。
function ReadSync:getDocumentDigest()
    local checksum = self.ui.doc_settings and self.ui.doc_settings:readSetting("partial_md5_checksum")
    if checksum and checksum ~= "" then
        return checksum
    end

    local file = self.ui.document and self.ui.document.file
    if not file then return nil end
    local _, file_name = util.splitFilePathName(file)
    if not file_name then return nil end
    logger.warn("ReadSync: 未取到 partial_md5_checksum，改用文件名 md5")
    return md5(file_name)
end

--- 当前位置（xpointer 或页码），与官方进度同步插件取值方式一致
function ReadSync:getCurrentProgress()
    if self.ui.paging and self.ui.paging.getLastProgress then
        return self.ui.paging:getLastProgress()
    end
    if self.ui.rolling and self.ui.rolling.getLastProgress then
        return self.ui.rolling:getLastProgress()
    end
    return nil
end

--- 已读百分比（0-1）
function ReadSync:getPercentFinished()
    local percent = self.ui.doc_settings and self.ui.doc_settings:readSetting("percent_finished")
    if type(percent) ~= "number" then return 0 end
    if percent < 0 then return 0 end
    if percent > 1 then return 1 end
    return percent
end

--- 本次会话已读秒数（仅在开启上报时返回）
function ReadSync:consumeReadingSeconds()
    if not self.settings.send_reading_time then
        self.session_started_at = os.time()
        return 0
    end
    local started = self.session_started_at
    self.session_started_at = os.time()
    if not started then return 0 end

    local elapsed = os.time() - started
    -- 单次上限与接口约定一致（86400 秒）。设备休眠时 os.time() 仍会走，
    -- 因此这里也用它兜底，避免把休眠时间当成阅读时间上报。
    if elapsed <= 0 or elapsed > 86400 then return 0 end
    return elapsed
end

function ReadSync:getDeviceName()
    if self.settings.device_name and self.settings.device_name ~= "" then
        return self.settings.device_name
    end
    return tostring(Device.model)
end

-- ----------------------------------------------------------------------------
-- 同步动作
-- ----------------------------------------------------------------------------

function ReadSync:testConnection()
    if (self.settings.server or "") == "" then
        show_message(_("请先填写服务器地址"))
        return
    end

    NetworkMgr:runWhenOnline(function()
        local health, err = Client:health(self.settings)
        if not health then
            show_message(_("连接失败：") .. tostring(err), 6)
            return
        end

        if (self.settings.token or "") == "" then
            show_message(_("服务器可达（版本 ") .. tostring(health.version) .. _("），但尚未填写访问令牌"), 6)
            return
        end

        local me, me_err = Client:me(self.settings)
        if not me then
            show_message(_("服务器可达，但令牌校验失败：") .. tostring(me_err), 8)
            return
        end

        show_message(
            _("连接正常\n服务器版本：") .. tostring(health.version)
                .. _("\n账号：") .. tostring(me.username)
                .. _("\n设备：") .. self:getDeviceName(),
            6
        )
    end)
end

--- 推送当前进度
-- @param silent 为 true 时不显示成功提示（自动同步用）
function ReadSync:pushProgress(silent)
    if not self:isConfigured() then
        if not silent then
            show_message(_("请先在「ReadSync 同步」菜单里填写服务器地址与访问令牌"))
        end
        return
    end

    local document = self:getDocumentDigest()
    if not document then
        if not silent then show_message(_("无法确定这本书的标识，已跳过同步")) end
        return
    end

    local progress = self:getCurrentProgress()
    if not progress then
        if not silent then show_message(_("无法读取当前阅读位置，已跳过同步")) end
        return
    end

    local title = self.ui.doc_props and self.ui.doc_props.display_title or nil
    local entry = {
        document = document,
        title = title,
        progress = tostring(progress),
        percentage = self:getPercentFinished(),
        platform = "koreader",
        device = self:getDeviceName(),
        deviceId = self.device_id or "unknown",
        readingSeconds = self:consumeReadingSeconds(),
        clientTime = os.date("!%Y-%m-%dT%H:%M:%SZ"),
    }

    NetworkMgr:runWhenOnline(function()
        local data, err, warning = Client:push(self.settings, entry)
        if not data then
            show_message(_("推送失败：") .. tostring(err), 6)
            return
        end
        if warning then
            notify(warning)
            return
        end
        if not silent then
            local percent = math.floor((entry.percentage or 0) * 100 + 0.5)
            notify(_("进度已同步（") .. percent .. "%）")
        end
    end)
end

--- 拉取远端进度并跳转
function ReadSync:pullProgress()
    if not self:isConfigured() then
        show_message(_("请先在「ReadSync 同步」菜单里填写服务器地址与访问令牌"))
        return
    end

    local document = self:getDocumentDigest()
    if not document then
        show_message(_("无法确定这本书的标识"))
        return
    end

    NetworkMgr:runWhenOnline(function()
        local entry, err = Client:pull(self.settings, document)
        if err then
            show_message(_("拉取失败：") .. tostring(err), 6)
            return
        end
        if not entry or not entry.progress then
            show_message(_("服务器上还没有这本书的进度"))
            return
        end

        local remote_percent = entry.percentage or 0
        local local_percent = self:getPercentFinished()

        -- 远端更靠前时才提示跳转，避免把已经读到后面的人拽回去
        if remote_percent <= local_percent then
            show_message(
                _("远端进度并不比本机靠前（远端 ")
                    .. math.floor(remote_percent * 100 + 0.5) .. "%，本机 "
                    .. math.floor(local_percent * 100 + 0.5) .. "%）",
                5
            )
            return
        end

        self:applyRemoteProgress(entry)
    end)
end

--- 把远端位置应用到当前文档
function ReadSync:applyRemoteProgress(entry)
    local progress = entry.progress
    local device = entry.device or _("其它设备")
    local percent = math.floor((entry.percentage or 0) * 100 + 0.5)

    -- 页码型进度是纯数字，xpointer 型形如 /body/DocFragment[..]/...
    if tostring(progress):match("^%d+$") then
        self.ui:handleEvent(Event:new("GotoPage", tonumber(progress)))
    else
        self.ui:handleEvent(Event:new("GotoXPointer", progress))
    end

    notify(_("已跳转到 ") .. tostring(device) .. _(" 的进度（") .. percent .. "%）")
end

-- ----------------------------------------------------------------------------
-- 事件钩子
-- ----------------------------------------------------------------------------

function ReadSync:onReaderReady()
    self.session_started_at = os.time()
end

function ReadSync:onCloseDocument()
    if self.settings.auto_push and self:isConfigured() then
        self:pushProgress(true)
    end
    self.session_started_at = nil
end

function ReadSync:onSuspend()
    if self.settings.push_on_suspend and self:isConfigured() then
        self:pushProgress(true)
    end
end

return ReadSync
