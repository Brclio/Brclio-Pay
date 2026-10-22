import { deploymentSkillFiles, skillVariants } from './skill-data';

export const SKILL_VARIANTS = ['brclio-pay-integrate', 'brclio-alipay-integrate', 'brclio-wechatpay-integrate'] as const;
export type SkillVariant = typeof SKILL_VARIANTS[number];
export function isSkillVariant(value: unknown): value is SkillVariant {
  return typeof value === 'string' && (SKILL_VARIANTS as readonly string[]).includes(value);
}
function selectedFiles(variant: SkillVariant): Record<string, string> {
  if (!isSkillVariant(variant)) throw new TypeError('Invalid payment Skill variant');
  return skillVariants[variant];
}

export function skillMarkdown(variant: SkillVariant = 'brclio-pay-integrate'): string {
  return selectedFiles(variant)[`${variant}/SKILL.md`];
}

/** Infrastructure deployment never accepts or carries a scoped product grant. */
export function deploymentSkillMarkdown(): string {
  return deploymentSkillFiles['brclio-pay-deploy/SKILL.md'];
}
export function deploymentSkillZip(): Uint8Array {
  return archiveZip('brclio-pay-deploy', deploymentSkillFiles);
}

export interface IntegrationPromptOptions {
  variant?: SkillVariant;
  clientId: string;
  mode: 'create' | 'update';
  paymentMode?: 'live' | 'sandbox';
  pricingMode?: 'detect' | 'manual';
  domainMode?: 'fixed' | 'auto';
  token: string;
  expiresAt: string;
  baseUrl: string;
}

/** Only this per-task prompt contains the short-lived, single-product grant. */
export function makeIntegrationPrompt({ variant = 'brclio-pay-integrate', clientId, mode, paymentMode, pricingMode = 'detect', domainMode = 'fixed', token, expiresAt, baseUrl }: IntegrationPromptOptions): string {
  const base = new URL(baseUrl);
  if (!isSkillVariant(variant) || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(clientId) || !['create', 'update'].includes(mode)
    || (paymentMode !== undefined && !['live', 'sandbox'].includes(paymentMode))
    || !['detect', 'manual'].includes(pricingMode)
    || !['fixed', 'auto'].includes(domainMode)
    || !/^brp_int_[A-Za-z0-9_-]{20,2000}$/.test(token) || !Number.isFinite(Date.parse(expiresAt))
    || base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new TypeError('Invalid scoped integration context');
  }
  return `请使用下方完整的 ${variant} Skill，为当前已授权的产品后端接入或更新 Brclio Pay。仅复制本消息即可开始，不需要另行附上 ZIP。先检查现有认证、订单、权益、支付与回调代码；保留它们，再完成最小改动。此临时授权仅允许指定产品的 context / plan / apply，不扩大目标仓库或发布权限。

支付接入范围：${variant === 'brclio-alipay-integrate' ? '仅支付宝，config.providers=["alipay"]' : variant === 'brclio-wechatpay-integrate' ? '仅微信，config.providers=["wechat"]' : '支付宝 + 微信，config.providers=["alipay","wechat"]'}
授权产品：${clientId}
操作类型：${mode === 'create' ? '新增该产品接入' : '修改该产品现有接入'}
支付环境：${paymentMode || '读取 context.paymentMode 确认；操作类型不表示支付环境'}
套餐来源模式：${pricingMode === 'detect' ? 'detect：读取当前项目已有套餐、价格和权益，以证据生成配置；无可靠资料或冲突时询问用户，不编造' : 'manual：使用用户本次明确指定的商品、价格和权益；缺少关键规则时询问用户，项目旧配置仅用于兼容检查'}
域名授权模式：${domainMode === 'auto' ? 'auto：用户允许为该产品自行发现或设计必要公网 HTTPS 来源；新增来源通过 plan 展示、apply 纳入记录，不需逐个再次授权' : 'fixed：只允许 context.allowedOrigins 内的新增或变更地址；来源内具体路径可自行设计，超出来源需要重新授权'}
支付中心：${base.origin}
授权到期：${new Date(expiresAt).toISOString()}
临时接入令牌（敏感，仅当前任务使用）：${token}

将临时令牌仅用于进程环境变量 BRCLIO_PAY_INTEGRATION_TOKEN，并设置 BRCLIO_PAY_BASE_URL。不要输出、提交或写入通用 Skill。用同一 Bearer 令牌请求 GET ${base.origin}/api/integration/v1/skill.zip，并在 X-Brclio-Skill 请求头设置 ${variant}，下载到当前任务专用、被 Git 忽略的临时目录并解压。凭证放在 Authorization 请求头，不放在 URL/query，也不开启 verbose 请求日志。下载只提供通用 Skill 与辅助脚本；不用全局安装。读取解压后的 SKILL.md 和 references/integration.md，从包内运行 scripts/inspect-platform.mjs 与 scripts/integration-client.mjs。

登记 config.webhookProtocol="brclio-v1"。如果 context.client.webhookProtocol 是 wechat-legacy-v1，先在产品实现、部署并验证新 webhook，同时保留旧格式接收和幂等过渡；之后才应用协议切换。已签发 outbox 保持原协议和外部平台身份，不创建第二份权益事件。

读取 /api/integration/v1/context 后，以 client.version 或 absent 生成单产品变更计划，核对 before / after 再应用；不要改动其他产品。产品长期凭证只进入其可信后端的 Secret；只有需要落地且用户任务授权时，使用脚本的 --credentials-file 写入 Git 忽略的 0600 新文件。

按本任务的套餐来源模式工作。detect 模式先读取现有后端商品配置、已有只读权限可访问的套餐记录及定价文档，以文件路径和行号或脱敏查询出处说明依据，再与前端展示交叉核对；manual 模式以用户明确规则为依据。缺少金额、SKU、币种、权益或有效期依据时不得擅自填写。本中心只收 CNY，不把美元等外币金额直接当人民币，也不自行编造换汇。先列出商品对应关系与冲突，再生成配置计划。

为目标产品实现服务端签名读取 GET /api/v1/catalog，通过产品后端展示最新启用商品并校验下单（不缓存或明确短缓存），使之后的后台价格变更可被这个已完成接入的产品读取。acceptingPayments=false 时保留报价与旧单处理，暂停新购买并明确提示收款未开放；目录可读不代表可以收款。目录检查后仍可能返回 PAYMENTS_DISABLED，保留原业务订单供恢复后幂等重试，不盲重试。createOrder 返回的 SKU/amount 是当笔支付订单的权威快照；若其与用户已确认的目录报价不同，不放出 checkoutUrl，提示重新确认新报价并用新业务订单重建。业务订单保存金额及产品实际权益规则快照，历史订单继续按创建时快照核对。权益说明字符串不能自动执行开通，真实规则修改仍需同步产品实现。未完成目录读取改造的旧产品不会自动同步新价。

以 context.domainMode 为域名权限依据。auto 模式允许为指定产品增加必要公网 HTTPS 来源：先检查实际部署/路由，把新增来源和具体 webhook/返回页放入 plan，核对 addedOrigins 后应用并报告；不要为省事开放无关或过宽通配域名。fixed 模式只允许 context.allowedOrigins 中的来源，但来源内具体路径可自行设计；超出范围时列出所需来源，请管理员重新授权。自动域名模式不能扩大到其他产品、延长令牌或授予目标仓库的新权限。

按 Skill 的接入协议实现服务端固定 SKU 下单、验签 webhook、持久化事务去重及权益开通；付款返回参数不能直接开通。沙箱不能开通正式权益。实现产品自己的已认证订单与实际权益查询：网页返回、桌面 focus、移动 resume 时立即查询，有界轮询持续到该订单权益实际提交；PAID 但权益 pending 不能停止。确认后刷新账号、会员标识和功能权限；超时保留原订单与手动查询，退出或切换账号清理旧请求。包内 assets/payment-completion.mjs 可用于客户端等待流程，它不含支付密钥。HTTPS 自动返回不保证原生应用自动前置。

当前任务已授权上线收款时，在目标产品仓库完成后端 Secret、回调/查单/返回页、前端和所需安装包发布与线上核对，不能停在中心配置已应用。中心 health 与产品签名目录均允许收款时，不需要返回支付仓库再次部署或改总开关；临时授权不能修改商户或总开关。新产品可按本次上线授权登记 enabled:true，已有产品保留启用状态，除非任务要求恢复。先完成模拟验证，再由用户在产品项目人工实付并核实实际权益与客户端显示；缺少权限时说明具体阻塞，不索取全账号凭证。最终报告配置版本、代码入口、验证结果和未完成项，不展示任何凭证。

---
以下为本任务可直接使用的完整通用 Skill；仅以上临时授权部分含任务凭证，通用包不包含凭证。

${skillMarkdown(variant)}`;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function header(length: number): { bytes: Uint8Array; view: DataView } {
  const bytes = new Uint8Array(length);
  return { bytes, view: new DataView(bytes.buffer) };
}

/** Small deterministic UTF-8 ZIP using method 0 (stored); no runtime filesystem. */
export function skillZip(variant: SkillVariant = 'brclio-pay-integrate'): Uint8Array {
  return archiveZip(variant, selectedFiles(variant));
}

function archiveZip(variant: string, files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const entries = Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  for (const [name, value] of entries) {
    if (!name.startsWith(`${variant}/`) || !/^[A-Za-z0-9_./-]+$/.test(name) || name.split('/').some(part => part === '..' || part === '')) throw new TypeError('Unsafe skill archive path');
    const filename = encoder.encode(name);
    const data = encoder.encode(value);
    const checksum = crc32(data);
    const local = header(30 + filename.length);
    local.view.setUint32(0, 0x04034b50, true);
    local.view.setUint16(4, 20, true);
    local.view.setUint16(6, 0x0800, true);
    local.view.setUint16(12, 0x0021, true);
    local.view.setUint32(14, checksum, true);
    local.view.setUint32(18, data.length, true);
    local.view.setUint32(22, data.length, true);
    local.view.setUint16(26, filename.length, true);
    local.bytes.set(filename, 30);
    const directory = header(46 + filename.length);
    directory.view.setUint32(0, 0x02014b50, true);
    directory.view.setUint16(4, 20, true);
    directory.view.setUint16(6, 20, true);
    directory.view.setUint16(8, 0x0800, true);
    directory.view.setUint16(14, 0x0021, true);
    directory.view.setUint32(16, checksum, true);
    directory.view.setUint32(20, data.length, true);
    directory.view.setUint32(24, data.length, true);
    directory.view.setUint16(28, filename.length, true);
    directory.view.setUint32(42, offset, true);
    directory.bytes.set(filename, 46);
    chunks.push(local.bytes, data);
    central.push(directory.bytes);
    offset += local.bytes.length + data.length;
  }
  const centralLength = central.reduce((sum, item) => sum + item.length, 0);
  const end = header(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, entries.length, true);
  end.view.setUint16(10, entries.length, true);
  end.view.setUint32(12, centralLength, true);
  end.view.setUint32(16, offset, true);
  const result = new Uint8Array(offset + centralLength + end.bytes.length);
  let cursor = 0;
  for (const chunk of [...chunks, ...central, end.bytes]) { result.set(chunk, cursor); cursor += chunk.length; }
  return result;
}
