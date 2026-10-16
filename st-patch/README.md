# ST 后端补丁：Google AI Studio / Vertex AI 请求头透传

## 为什么需要它

SillyTavern 的 Google 系聊天完成源（Google AI Studio / Vertex AI）由后端 `sendMakerSuiteRequest()` 处理，
它把上游请求头**写死**为：

```js
headers: {
    'Content-Type': 'application/json',
},
```

API key 走 `?key=` 查询参数，并且服务端**完全不解析** `custom_include_headers`（该字段只在 `custom` 源的分支里
被 `mergeObjectWithYaml()` 合并）。因此**纯前端扩展无法给 Google 源注入任何请求头** —— 这是 ST 服务端的硬限制。

本补丁在 `sendMakerSuiteRequest()` 里加一个透传点：客户端通过请求体字段 `open_code_headers`（YAML 字符串）
传入的头会被合并到上游请求上。配套扩展在源为 `makersuite` / `vertexai` 时会自动填充该字段。

## 安装

**在 SillyTavern 根目录**执行（脚本默认操作 `src/endpoints/backends/chat-completions.js`）：

```bash
cd <SillyTavern 根目录>
node <本仓库路径>/st-patch/install.mjs
```

或直接使用等价的 git 补丁：

```bash
cd <SillyTavern 根目录>
git apply <本仓库路径>/st-patch/opencode-google-headers.patch
```

安装后重启 SillyTavern。脚本是**幂等**的，重复执行安全。

## 其它命令

```bash
node <本仓库路径>/st-patch/install.mjs --check    # 只查看状态（退出码 0=已打，2=未打）
node <本仓库路径>/st-patch/install.mjs --revert   # 还原（逐字节还原，已验证）
node <本仓库路径>/st-patch/install.mjs --file <路径>   # 操作指定的文件副本
```

## 验证

```bash
node <本仓库路径>/st-patch/test-opencode-google-headers.mjs <SillyTavern 根目录>
```

测试会加载**真实的** chat-completions 路由，并起一个本地假上游，断言：

- 客户端传入的 `x-opencode-session` / `user-agent` / `x-opencode-client` 确实到达上游
- 原有的 `Content-Type` 与 `?key=` 认证方式不受影响
- 请求打到 `/v1beta/models/<model>:generateContent`（路径与查询串未被改动）
- 回归：客户端没传 `open_code_headers` 时不额外发送任何头
- 回归：YAML 格式错误时请求依然成功（`mergeObjectWithYaml` 自带 try/catch）
- Vertex AI 源（若该 ST 版本支持）走同一路径，否则显示 SKIP

## ST 更新后

`git pull` 更新 SillyTavern 会覆盖 `src/endpoints/backends/chat-completions.js`，需要重新执行安装命令。

## 覆盖范围与限制

- **已覆盖**：`sendMakerSuiteRequest()` —— Google AI Studio 与 Vertex AI 的聊天补全（`/generate` 路由）。
- **未覆盖**：图像描述路由 `POST /api/google/caption-image`（`src/endpoints/google.js`）走的是另一套请求构造，
  不在本补丁范围内。
- 补丁只做「把客户端提供的头合并进上游请求」，**不改动**认证方式、**不改动**请求体、**不影响**其它 provider。
- 未安装补丁时扩展仍然可用，只是 Google 源不会带上 opencode 头。

## 手动等价改法

不想用脚本的话，改两处即可：

1. 在 `sendMakerSuiteRequest()` 之前加一个函数：

```js
function getMakerSuiteHeaders(request) {
    const headers = { 'Content-Type': 'application/json' };

    if (typeof request.body.open_code_headers === 'string' && request.body.open_code_headers.trim()) {
        mergeObjectWithYaml(headers, request.body.open_code_headers);
    }

    return headers;
}
```

2. 把该函数里 fetch 的 `headers: { 'Content-Type': 'application/json' },` 换成
   `headers: getMakerSuiteHeaders(request),`。
