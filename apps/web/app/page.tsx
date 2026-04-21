const modules = [
  {
    title: '项目 / 设定',
    desc: '项目、角色、Lorebook、风格与模型配置的统一入口。',
  },
  {
    title: '大纲 / 章节',
    desc: '分卷、章节、场景的层级规划与导航。',
  },
  {
    title: '生成 / 校验',
    desc: '章节生成、上下文召回、事实校验、记忆回写。',
  },
  {
    title: '版本 / 审计',
    desc: '草稿版本、回滚、审计日志与问题追踪。',
  },
];

export default function HomePage() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 px-6 py-10">
      <div className="mx-auto flex max-w-7xl flex-col gap-8">
        <header className="panel p-8">
          <div className="mb-3 inline-flex rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-sm text-cyan-200">
            AI Novel System Scaffold
          </div>
          <h1 className="text-4xl font-bold tracking-tight text-white">长篇小说创作系统 · 工程脚手架</h1>
          <p className="mt-4 max-w-3xl text-base leading-7 text-slate-300">
            当前页面是一个最小前端占位，用于承接后续的项目管理、章节编辑、记忆检索、校验问题与生成工作流 UI。
          </p>
        </header>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {modules.map((item) => (
            <article key={item.title} className="panel p-6">
              <h2 className="text-lg font-semibold text-white">{item.title}</h2>
              <p className="mt-3 text-sm leading-6 text-slate-400">{item.desc}</p>
            </article>
          ))}
        </section>

        <section className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
          <div className="panel p-6">
            <h2 className="text-xl font-semibold text-white">MVP 已落位的工程边界</h2>
            <ul className="mt-4 space-y-3 text-sm leading-6 text-slate-300">
              <li>• API 层只处理资源接口、DTO 校验与任务投递。</li>
              <li>• Worker 层负责 prompt 编排、检索、校验与回写。</li>
              <li>• Postgres 承载结构化事实，pgvector 承载记忆召回。</li>
              <li>• Redis 保留给缓存与异步任务队列。</li>
            </ul>
          </div>

          <div className="panel p-6">
            <h2 className="text-xl font-semibold text-white">下一步建议</h2>
            <ol className="mt-4 list-decimal space-y-3 pl-5 text-sm leading-6 text-slate-300">
              <li>接入真实数据库与 Prisma migration。</li>
              <li>补齐角色、Lorebook、章节、版本的 API 模块。</li>
              <li>把 Worker mock LLM 切换成真实 provider gateway。</li>
              <li>实现 SSE / WebSocket 任务状态流。</li>
            </ol>
          </div>
        </section>
      </div>
    </main>
  );
}
