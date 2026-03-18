/**
 * extract-code-entities.sc
 *
 * 用法：
 *   joern --script joern/extract-code-entities.sc \
 *         --param cpgFile=/path/to/repo.cpg.bin \
 *         --param outFile=/path/to/context-knowledge-graph/data/output.json \
 *         --param repoName=my-repo
 */

@main def extractCodeEntities(
  cpgFile: String,
  outFile: String,
  repoName: String = "bite-me-website"
) = {

  importCpg(cpgFile)

  val repo = repoName
  val nodes = scala.collection.mutable.ArrayBuffer[ujson.Value]()
  val calls = scala.collection.mutable.ArrayBuffer[ujson.Value]()

  // ── 1. 服务节点 ──────────────────────────────────────
  nodes += ujson.Obj(
    "id"          -> s"svc:$repo",
    "entity_type" -> "service",
    "name"        -> repo,
    "repo"        -> repo,
    "path"        -> ujson.Null
  )

  // ── 2. 文件节点 ────────────────────────────────────────
  cpg.file
    .filterNot(f => f.name == "<unknown>" || f.name.contains("node_modules"))
    .foreach { f =>
      val cleanPath = f.name.replaceAll("^/", "")
      nodes += ujson.Obj(
        "id"          -> s"file:$repo/$cleanPath",
        "entity_type" -> "file",
        "name"        -> cleanPath.split("/").last,
        "repo"        -> repo,
        "path"        -> cleanPath
      )
    }

  // ── 3. 函数节点 ────────────────────────────────────────
  cpg.method
    .filterNot(m =>
      m.name.startsWith("<") ||
      m.filename.contains("node_modules") ||
      m.filename == "<unknown>"
    )
    .foreach { m =>
      val cleanPath = m.filename.replaceAll("^/", "")
      nodes += ujson.Obj(
        "id"          -> s"fn:$repo/${cleanPath}::${m.name}",
        "entity_type" -> "function",
        "name"        -> m.name,
        "repo"        -> repo,
        "path"        -> cleanPath,
        "line_start"  -> m.lineNumber.getOrElse(-1),
        "line_end"    -> m.lineNumberEnd.getOrElse(-1)
      )
    }

  // ── 4. 调用关系 ────────────────────────────────────────
  cpg.call
    .filterNot(c =>
      c.methodFullName.startsWith("<") ||
      c.file.name.headOption.getOrElse("").contains("node_modules")
    )
    .foreach { c =>
      val callerFile = c.file.name.headOption.getOrElse("<unknown>").replaceAll("^/", "")
      calls += ujson.Obj(
        "caller_id"   -> s"fn:$repo/${callerFile}::${c.method.name}",
        "callee_id"   -> s"fn:$repo/${c.methodFullName}",
        "callee_name" -> c.name,
        "line"        -> c.lineNumber.getOrElse(-1)
      )
    }

  // ── 输出 ───────────────────────────────────────────────
  val output = ujson.Obj(
    "repo"  -> repo,
    "nodes" -> ujson.Arr(nodes.toSeq: _*),
    "calls" -> ujson.Arr(calls.toSeq: _*)
  )

  os.write(os.Path(outFile), ujson.write(output, indent = 2))
  println(s"✅ 导出完成: ${nodes.length} 个节点, ${calls.length} 条调用关系 -> $outFile")
}
