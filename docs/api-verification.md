# 百度网盘只读统计接口验证记录

验证日期：2026-10-08。验证对象为用户已登录的百度网盘网页版，仅读取目录及计算大小；没有执行文件修改。

## 已确认的请求

- `GET /api/gettemplatevariable`，`fields=["uk"]`：返回 `errno=0`、`result.uk`，用于确定账户标识。文档不记录真实账户 ID。
- `GET /api/list`：参数 `dir`、`num=1000`、`page`、`order=name`、`desc=0`。首次验证使用 `num=100`，性能优化时已验证 `num=1000` 确实能返回超过 100 条：同一目录原来第一页返回 100 条，提高页大小后返回 272 条。实际文件夹 `size=0`，因此列表中的文件夹大小不能用于占用统计。必须读取所有分页；无 `has_more` 时按请求页大小判断下一页。
- `GET /api/quota`：返回 `used` 和 `total`，为整体容量展示使用。
- `POST /api/dirsize`：表单字段 `list` 为包含 `path` 的对象数组的 JSON。返回 `errno=0` 和 `taskid`。该 POST 只创建统计计算任务，不创建、删除或移动文件。
- `GET /api/taskquery`：参数 `taskid`。成功返回 `status=success`、`task_errno=0` 和 `list`，每项含 `path`、`size`、`filenum`、`dirnum`。

请求带 `app_id=250528`、`web=1`、`clienttype=0`，并使用浏览器已有的同源登录状态，不提取 Cookie 或密码。

## 实测结果

对一个现有图片目录，异步任务成功返回总大小 `9,603,576,627` 字节、1776 个文件、23 个子目录。验证只证明该调用在当前账户和当前日期可用，不能保证所有目录都可计算。

已观察到：尝试以 GET 和单个 `path` 参数调用目录大小接口返回 `errno=2`；不能以看到脚本存在 URL 就断言调用已打通。改为 POST `list` 后成功。

## 证据来源

1. 当前网页版公开主脚本 `https://nd-static.bdstatic.com/m-static/v20-main/home/js/home.ba8ddd2c.js` 含 `/api/list`、`/api/dirsize` 和 `/api/taskquery`。
2. 公开参考项目 https://github.com/pjpv/baidupan_dirsize_view 的 `baidu_dirsize_view.js` 展示 POST 列表与任务查询的用法。仅参考接口协议，没有复制其实现或界面代码。
3. 在用户已登录的浏览器中，对列表、容量、账户标识、目录统计提交和结果查询分别实测成功。该实验没有把登录凭据、原始全盘列表或账户 ID 写入项目。

## 产品中的边界

仅允许上述固定接口。除只读计算任务外，不存在任意 POST、上传、下载、删除、移动、分享入口。扩展只申请 `scripting`、`storage` 和 `https://pan.baidu.com/*` 主机访问。

已实测两个目录一起提交统计并成功返回各自的大小与计数。目前每批 10 个目录、最多并行 2 批；两批并行调度和近期缓存的界面行为使用隔离的模拟扩展接口验证，不把模拟测试视作真实账户性能保证。接口桥仍允许最多 20 个目录的只读提交，遇到失败会明确标明，不伪造 0。递归列表汇总是备用路径。

内部接口可能变化或受限。统计失败时不标为完整，不依据未知结果自动删除。普通目录结果与账户总体配额可能存在范围差异。
