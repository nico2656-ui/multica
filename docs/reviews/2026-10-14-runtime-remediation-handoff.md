# multica：运行路径整改交接与验收清单

- 记录日期：2026-10-14 UTC
- 本次重新核对默认分支：`main`，完整提交 `3df95c84b8af6f26b6d4fe8ccfcaca74ee977cf1`，与 2026-10-13 静态审计基线一致
- 完整递归树：`248e98f0a3b5e7bc9c4eb42b2b4f1316302bc33e`，1592 项，未截断
- 状态：待实施、待运行验收。本 PR 仅提交审查交接文档；没有修复下述缺陷，也不是安全认证
- 证据边界：源码行为与带前提的静态推导分开记录；未构建、安装、运行仓库程序、执行动态利用或访问真实数据/凭据

本文只使用本公开仓库的代码和文档，不包含其他仓库或实际部署的私人材料。

### M1 公开固定 JWT 默认值与生产配置 fail-open

判定：P1，源码确认配置缺陷；是否已暴露取决于部署。

[server/internal/auth/jwt.go L12-26](https://github.com/nico2656-ui/multica/blob/3df95c84b8af6f26b6d4fe8ccfcaca74ee977cf1/server/internal/auth/jwt.go#L12-L26) 在 JWT_SECRET 空缺时使用源码中的固定默认值；[server/cmd/server/main.go L118-134](https://github.com/nico2656-ui/multica/blob/3df95c84b8af6f26b6d4fe8ccfcaca74ee977cf1/server/cmd/server/main.go#L118-L134) 仅警告而不拒绝启动。[docker-compose.selfhost.yml L31-63](https://github.com/nico2656-ui/multica/blob/3df95c84b8af6f26b6d4fe8ccfcaca74ee977cf1/docker-compose.selfhost.yml#L31-L63) 同时设置生产环境、发布端口，并为 JWT_SECRET 提供公开占位默认值。鉴权随后用该 HMAC 密钥验证并采信 sub。[server/internal/middleware/auth.go L91-124](https://github.com/nico2656-ui/multica/blob/3df95c84b8af6f26b6d4fe8ccfcaca74ee977cf1/server/internal/middleware/auth.go#L91-L124)。

前提：操作者未替换默认密钥，且服务可被攻击者访问；攻击者掌握一个有效身份标识。此时 token 签名不再证明可信签发者。没有查看任何实际环境变量、token、用户秘密，也没有判断真实部署是否用了默认值。

下一步：生产缺少密钥或等于已知占位值时拒绝启动；compose 改必填；若确认曾采用公开默认值部署，应按事件处置轮换并失效旧会话。

### M2 本地附件下载绕过用户与工作区鉴权

判定：P1，源码确认，适用于 LocalStorage。

[server/cmd/server/router.go L187-193](https://github.com/nico2656-ui/multica/blob/3df95c84b8af6f26b6d4fe8ccfcaca74ee977cf1/server/cmd/server/router.go#L187-L193) 把 /uploads/* 放在受 Auth 保护的 API 组之外；后者始于 [server/cmd/server/router.go L236-239](https://github.com/nico2656-ui/multica/blob/3df95c84b8af6f26b6d4fe8ccfcaca74ee977cf1/server/cmd/server/router.go#L236-L239)。[server/internal/storage/local.go L90-115](https://github.com/nico2656-ui/multica/blob/3df95c84b8af6f26b6d4fe8ccfcaca74ee977cf1/server/internal/storage/local.go#L90-L115) 返回可直接访问的 URL，并以 http.ServeFile 交付，未验证用户、工作区成员或附件归属。

上传时检查成员关系不覆盖后续下载。[server/internal/handler/file.go L156-218](https://github.com/nico2656-ui/multica/blob/3df95c84b8af6f26b6d4fe8ccfcaca74ee977cf1/server/internal/handler/file.go#L156-L218)。任何拿到 URL 的人都可以读取；撤销成员关系也不会使链接失效。随机 UUID 降低猜测概率，但不是权限校验。本报告没有验证附件能被枚举，也未读取实际附件。

下一步：下载改经附件 ID 查询并验证当前成员关系，或采用可撤销/短时签名 URL；公开头像与私有工作区文件分开存储与路由。验收至少包含匿名、跨工作区、已退组访问。

### M3 未隔离的 HTML 和脚本上传构成同源脚本执行条件

判定：P1 条件推导；源码中的文件策略缺口已确认，未做浏览器复现。

上传保留用户扩展名，嗅探 MIME 但没有拒绝活动内容。[server/internal/handler/file.go L19-28](https://github.com/nico2656-ui/multica/blob/3df95c84b8af6f26b6d4fe8ccfcaca74ee977cf1/server/internal/handler/file.go#L19-L28)、[server/internal/handler/file.go L132-168](https://github.com/nico2656-ui/multica/blob/3df95c84b8af6f26b6d4fe8ccfcaca74ee977cf1/server/internal/handler/file.go#L132-L168)。LocalStorage 下载没有 attachment 强制下载或 sandbox 响应策略，文件与 API 同源。[server/internal/storage/local.go L109-115](https://github.com/nico2656-ui/multica/blob/3df95c84b8af6f26b6d4fe8ccfcaca74ee977cf1/server/internal/storage/local.go#L109-L115)。全局 CSP 的 script-src self 允许同源外部脚本，不能阻止上传 HTML 引用另一份同源上传 JS。[server/internal/middleware/csp.go L5-18](https://github.com/nico2656-ui/multica/blob/3df95c84b8af6f26b6d4fe8ccfcaca74ee977cf1/server/internal/middleware/csp.go#L5-L18)。

前提：启用本地存储；攻击者能登录上传文件；另一名已登录用户打开所上传 HTML；该 URL 与其 API cookie 同源。此时外部 JS 不需 inline-script 权限即可在 API 源执行并使用该用户的会话。CSRF 的可读 cookie 与请求头机制用于防跨站请求，不隔离同源脚本，不能作为此链条的充分阻断。[server/internal/auth/cookie.go L95-142](https://github.com/nico2656-ui/multica/blob/3df95c84b8af6f26b6d4fe8ccfcaca74ee977cf1/server/internal/auth/cookie.go#L95-L142)。具体浏览器 MIME 处理、反向代理额外头、生产站点拓扑未核验。

下一步：把不可信文件放到无会话 cookie 的独立 origin；活动内容默认 attachment，必要预览使用严格沙箱；限制 MIME/扩展名组合并补 nosniff；与 M2 一起验收鉴权下载及 HTML+外部 JS 情形。

### M4 自动回收会删除完整任务目录

判定：已确认的保留策略与使用风险，未单列为已发生的数据丢失漏洞。

默认配置启用 GC（[配置实际默认值](https://github.com/nico2656-ui/multica/blob/3df95c84b8af6f26b6d4fe8ccfcaca74ee977cf1/server/internal/daemon/config.go#L316-L318)），任务 TTL 24小时、孤立任务72小时、产物12小时。[server/internal/daemon/config.go L1-100](https://github.com/nico2656-ui/multica/blob/3df95c84b8af6f26b6d4fe8ccfcaca74ee977cf1/server/internal/daemon/config.go#L1-L100)。GC 对超过期限的 done/cancelled 目录，以及 API 返回404且目录足够旧的路径，调用 cleanTaskDir 中的 os.RemoveAll；删除前没有检查工作树未提交修改是否已备份。[server/internal/daemon/gc.go L188-246](https://github.com/nico2656-ui/multica/blob/3df95c84b8af6f26b6d4fe8ccfcaca74ee977cf1/server/internal/daemon/gc.go#L188-L246)。

前提：工作目录还包含用户唯一的数据或未推送修改，且满足回收条件。404 也可能来自对象不可见，因此应明确“不可查询”和“应永久回收”的区别。下一步明确工作区生命周期与备份契约，删除前检查未提交/未推送内容，对归属不明目录采用隔离保留；不要把任务目录用作唯一副本。

### 已存在的边界与完成度

已读 JWT/PAT/cookie CSRF、工作区成员中间件、daemon token、private chat scope authorizer；存在有效边界，不能泛称全站未鉴权。随机文件键不直接使用原文件路径，本轮未证实上传路径穿越。git 调用使用 argv，不因能传参数就认定 shell 注入。

实际阅读：router.go 100–380及相关全局中间件；auth.go 1–145；workspace.go 1–227；daemon_auth.go 1–200；scope_authorizer.go 1–97；local.go 1–126；file.go 1–360；cookie.go 1–189；jwt.go 1–54；gc.go 1–412；config.go 默认值与 GC 配置段；project_resource.go 1–284；desktop main 1–280、preload、daemon-manager 生命周期段；其余已取文件仅相关调用点。

下一项优先修 M1/M2，并隔离活动文件。未逐一审核所有 handler/数据库迁移/查询、所有 realtime 消息、S3/CloudFront 部署、自动更新签名或真实多租户攻击路径。2026-10-13 审计读取的默认 head 无 CI 报告，不能从大型目录和丰富页面推定已通过部署验收。

## 可关闭发现的验收条件

以下为后续实现的验收要求，所有复选项均未在本 PR 执行。

- [ ] M1：生产配置缺少 JWT_SECRET、空白值或已知占位值时在监听端口前失败；合法显式测试密钥启动成功；开发行为和 compose 必填行为明确。只使用合成凭据，不读取或轮换真实凭据。
- [ ] M2：匿名、无工作区成员关系、跨工作区、已撤销成员、删除附件均不能下载；现有授权成员可下载；缓存和短时 URL 的撤销语义明确；公开头像与私有附件独立验证。
- [ ] M3：无害 HTML + 外部 JS fixture 在实际下载/预览路径上不能取得应用源脚本权限；检查 Content-Type、Content-Disposition、nosniff、CSP 与 cookie origin；覆盖反向代理额外响应头，不以单测代替浏览器结果。
- [ ] M4：含未提交或未推送内容的到期目录保持可恢复；API 404、暂时不可见和重试失败不直接等于删除授权；明确隔离期、恢复方式与审计记录。
- [ ] 按仓库贡献流程在独立测试数据库运行相关 Go/TS/端到端验证；记录确切提交和环境。此文档没有改变任何运行配置、权限、密钥或删除策略。

## 提交验证范围

本轮验证限于固定 SHA 的代码链接、文档内容、路径白名单与 Git 全树完整性。构建、类型检查、仓库测试和运行时验收均未运行；文档提交不改变风险状态。后续代码修复必须单列实际执行的命令、结果、提交 SHA 和仍未覆盖的条件，禁止把本清单复选项预先标记完成。
