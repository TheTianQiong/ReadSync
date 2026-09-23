--[[
ReadSync 同步客户端。

负责与 ReadSync 服务端的「统一同步接口」（/api/sync/*）通信。
与官方 KOSync 插件的区别：用 Bearer 令牌代替 md5(密码)，
因此不需要主密码参与，也不会把密码的 md5 暴露给网络。

所有方法都是同步的，并设置较短的超时（KOReader 的界面是单线程的，
请求过久会让界面卡住）。调用方应当先通过 NetworkMgr 确认网络可用。
--]]

local http = require("socket.http")
local ltn12 = require("ltn12")
local logger = require("logger")
local rapidjson = require("rapidjson")
local socketutil = require("socketutil")

local Client = {}

-- 连接/整体超时（秒）。参照官方 KOSync 插件的取值：宁可快速失败，
-- 也不要让阅读界面长时间无响应。
local TIMEOUT_CONNECT = 3
local TIMEOUT_TOTAL = 8

--- 选择底层 HTTP 模块。
-- socket.http 在 KOReader 里通常已能处理 https，但为稳妥起见显式分派，
-- 失败时回退到 socket.http（至少能跑通纯 HTTP 的自建服务器）。
local function pick_http(url)
    if url:match("^https://") then
        local ok, ssl_https = pcall(require, "ssl.https")
        if ok and ssl_https then
            return ssl_https
        end
        logger.warn("ReadSync: 未能加载 ssl.https，HTTPS 请求可能失败")
    end
    return http
end

--- 去掉末尾斜杠，避免拼出 //api/sync
local function normalize_base(base)
    return (base:gsub("/+$", ""))
end

--- 解析服务端返回的统一信封。
-- 成功：{ ok = true, data = ... }
-- 失败：{ ok = false, error = { code, message } }
-- 这里把失败也转成可读的中文消息，插件只负责展示。
local function parse_response(code, body)
    if not body or body == "" then
        return nil, string.format("服务器返回空响应（HTTP %s）", tostring(code))
    end

    local decoded = rapidjson.decode(body)
    if type(decoded) ~= "table" then
        return nil, string.format("服务器返回了非预期内容（HTTP %s）", tostring(code))
    end

    if decoded.ok == true then
        return decoded.data
    end

    local message = "同步失败"
    if type(decoded.error) == "table" and decoded.error.message then
        message = decoded.error.message
    end
    return nil, message
end

--- 发起一次请求。
-- @return data, err  二者必有其一为 nil
function Client.request(method, url, headers, body)
    local sink = {}
    local request_headers = headers or {}
    if body then
        request_headers["Content-Type"] = "application/json"
        request_headers["Content-Length"] = tostring(#body)
    end

    local http_module = pick_http(url)
    socketutil:set_timeout(TIMEOUT_CONNECT, TIMEOUT_TOTAL)

    local ok, code, resp_headers = http_module.request({
        url = url,
        method = method,
        headers = request_headers,
        source = body and ltn12.source.string(body) or nil,
        sink = ltn12.sink.table(sink),
    })

    socketutil:reset_timeout()

    -- socket.http 失败时返回 nil + 错误字符串（此时 code 是错误信息）
    if not ok then
        local reason = tostring(code)
        if reason:match("timeout") then
            return nil, "连接服务器超时，请检查地址与网络"
        end
        if reason:match("connection refused") then
            return nil, "服务器拒绝连接，请确认服务已启动且端口正确"
        end
        return nil, "无法连接服务器：" .. reason
    end

    return parse_response(code, table.concat(sink))
end

--- 组装请求头
local function auth_headers(config)
    return {
        ["Authorization"] = "Bearer " .. (config.token or ""),
        ["Accept"] = "application/json",
    }
end

--- 健康检查（不需要认证），用于「测试连接」的快速判断
function Client:health(config)
    local base = normalize_base(config.server or "")
    if base == "" then
        return nil, "请先填写服务器地址"
    end
    return Client.request("GET", base .. "/api/system/health", { ["Accept"] = "application/json" })
end

--- 校验令牌是否有效，并取回用户名（用于在菜单里显示当前账号）
function Client:me(config)
    local base = normalize_base(config.server or "")
    if base == "" then
        return nil, "请先填写服务器地址"
    end
    if (config.token or "") == "" then
        return nil, "请先填写访问令牌"
    end
    return Client.request("GET", base .. "/api/auth/me", auth_headers(config))
end

--- 推送阅读进度。
-- @param entry 表，字段见 docs/api-reference.md 的统一同步接口：
--   document, title, progress, percentage, platform, device, deviceId, readingSeconds
function Client:push(config, entry)
    local base = normalize_base(config.server or "")
    if base == "" then
        return nil, "请先填写服务器地址"
    end
    if (config.token or "") == "" then
        return nil, "请先填写访问令牌"
    end

    local body = rapidjson.encode(entry)
    local data, err = Client.request("PUT", base .. "/api/sync/progress", auth_headers(config), body)
    if not data then
        return nil, err
    end

    -- accepted=false 表示服务端已有更新的进度，不是错误，但需要让用户知道
    if data.accepted == false then
        return data, nil, "服务端已有更新的进度，本次未覆盖"
    end
    return data
end

--- 拉取指定文档的进度
function Client:pull(config, document)
    local base = normalize_base(config.server or "")
    if base == "" then
        return nil, "请先填写服务器地址"
    end
    if (config.token or "") == "" then
        return nil, "请先填写访问令牌"
    end

    -- document 可能含 / 等字符（我们用文件路径或 md5，通常安全），仍做一次转义以求稳妥
    local escaped = document:gsub("[^%w%-%._~]", function(c)
        return string.format("%%%02X", string.byte(c))
    end)

    local data, err = Client.request("GET", base .. "/api/sync/progress/" .. escaped, auth_headers(config))
    if not data then
        return nil, err
    end
    return data.entry
end

return Client
