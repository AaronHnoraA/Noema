;;; "Compiled" snippets and support files for `java-mode'  -*- lexical-binding:t -*-
;;; Snippet definitions:
;;;
(yas-define-snippets 'java-mode
		     '(("ram"
			"log.info(\"\\n==== [log]: {}\", RamUsageEstimator.shallowSizeOf($0));"
			"ram" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/ram"
			nil nil)
		       ("pac"
			"package `(mapconcat 'identity (split-string (replace-regexp-in-string \".*src\\\\(/\\\\(main\\\\|test\\\\)\\\\)?\\\\(/java\\\\)?\" \"\" default-directory) \"/\" t) \".\")`;\n\nimport lombok.Data;\nimport lombok.NoArgsConstructor;\nimport lombok.extern.slf4j.Slf4j;\n\n/**\n * @author `(getenv \"USER\")`\n * @time `(format-time-string \"%Y-%m-%d %H:%M:%S\")`\n **/\n@Data\n@Slf4j\n@NoArgsConstructor\npublic class `(file-name-sans-extension (buffer-name))` {\n    $0\n}"
			"package-class" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/package-class"
			nil nil)
		       ("pan"
			"package `(mapconcat 'identity (split-string (replace-regexp-in-string \".*src\\\\(/\\\\(main\\\\|test\\\\)\\\\)?\\\\(/java\\\\)?\" \"\" default-directory) \"/\" t) \".\")`;"
			"pack-class-name" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/pack-class-name"
			nil nil)
		       ("func"
			"/**\n * @since `(format-time-string \"%Y-%m-%d\")`\n **/\npublic void functiont(){\n    $0\n}\n"
			"func" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/func"
			nil nil)
		       ("enum"
			"package `(mapconcat 'identity (split-string (replace-regexp-in-string \".*src\\\\(/\\\\(main\\\\|test\\\\)\\\\)?\\\\(/java\\\\)?\" \"\" default-directory) \"/\" t) \".\")`;\n\nimport lombok.Getter;\nimport lombok.AllArgsConstructor;\n\n/**\n * @author `(getenv \"USER\")`\n * @time `(format-time-string \"%Y-%m-%d %H:%M:%S\")`\n **/\n@Getter\n@AllArgsConstructor\npublic enum `(file-name-sans-extension (buffer-name))` {\n    $0\n    SUBMIT      (  0  , \"提交\"   ),\n    UNDER_REVIEW(  1  , \"审核中\" );\n\n    private int code;\n    private String desc;\n}"
			"enum" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/enum"
			nil nil)
		       ("aut"
			"/**\n * @author `(getenv \"USER\")`\n * @since `(format-time-string \"%Y-%m-%d\")`\n **/"
			"author" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/author"
			nil nil)
		       ("sw"
			"@SuppressWarnings({\"rawtypes\", \"unchecked\", \"deprecation\", \"unused\"})"
			"SuppressWarnings" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/SuppressWarnings"
			nil nil)))


;;; Snippet definitions:
;;;
(yas-define-snippets 'java-mode
		     '(("todo" "//TODO $0" "todo" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/comments/todo"
			nil nil)
		       ("time"
			" `(format-time-string \"%Y-%m-%d %H:%M:%S\")`"
			"time" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/comments/time"
			nil nil)
		       ("/" "/**\n * $0\n */" "comment" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/comments/comment"
			nil nil)))


;;; Snippet definitions:
;;;
(yas-define-snippets 'java-mode
		     '(("page"
			"QueryWrapper<${1:Dto}> $1QueryWrapper = new QueryWrapper<>();\nPage<$1> page = new Page<$1>(${2:qo}.getPageIndex(), $2.getPageSize());\nIPage<$1> pageList = taskMapper.selectPage(page, $1QueryWrapper);"
			"page" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/dao/page"
			nil nil)
		       ("lq"
			"LambdaQueryWrapper<${1:Dto}> queryWarpper = Wrappers.<$1>lambdaQuery()\n    .eq($1::getStatus, 1)\n    .in(org.apache.commons.lang.StringUtils.isNotBlank(\"\"), $1::getId, new ArrayList())\n    .orderByAsc($1::getId);\nList<$1> listFromDb = $2.list(new Page<>(0, 1), queryWarpper);\n$1 eoFromDb = $2.selectOne(queryWarpper);"
			"lambdaquery" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/dao/lambdaquery"
			nil nil)))


;;; Snippet definitions:
;;;
(yas-define-snippets 'java-mode
		     '(("singleton"
			"public class Singleton {\n\n    private Singleton() {}\n\n    private static class SingletonContainer {\n        private static Singleton instance = new Singleton();\n    }\n\n    public static Singleton getInstance() {\n        return SingletonContainer.instance;\n    }\n}"
			"singleton" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/dmode/singleton"
			nil nil)))


;;; Snippet definitions:
;;;
(yas-define-snippets 'java-mode
		     '(("fileread"
			"FileReader fileReader = new FileReader(\"test.properties\");\nString result = fileReader.readString();"
			"fileread" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/file/fileread"
			nil nil)))


;;; Snippet definitions:
;;;
(yas-define-snippets 'java-mode
		     '(("tomap"
			"Map<Long, ${1:Dto}> id2EntityMap = ${2:list}.stream()\n                .collect(Collectors.toMap(item -> item, item -> item, (item1, item2) -> item1, TreeMap::new));"
			"tomap" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/lambda/toMap"
			nil nil)
		       ("tolist"
			"${1:list}.stream()\n    .filter  (item -> !StringUtils.isEmpty(item.toString()))\n    .map     (item -> item)\n    .sorted  (Comparator.comparing(   Long::longValue ).reversed())\n    .sorted  (Comparator.comparing( String::toString  ).reversed())\n    .collect (Collectors.toList());"
			"tolist" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/lambda/toList"
			nil nil)
		       ("sl" "Collections.singletonList(null);"
			"singletonList" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/lambda/singletonList"
			nil nil)
		       ("groupby"
			"Map<Long, List<${1:Dto}>> id2EntitiesMap = ${2:list}.stream()\n                .collect(Collectors.groupingBy($1::getId));"
			"groupby" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/lambda/groupby"
			nil nil)))


;;; Snippet definitions:
;;;
(yas-define-snippets 'java-mode
		     '(("lsp"
			"log.info(\"===================this is Divider line===============\");"
			"splite" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/logsnippet/splite"
			nil nil)
		       ("logj"
			"log.info(\"==== [log]: {}\", JSON.toJSONString($0, SerializerFeature.PrettyFormat));"
			"logj" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/logsnippet/logj"
			nil nil)
		       ("logi" "log.info(\"==== [log]: {}\");" "logi"
			nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/logsnippet/logi"
			nil nil)
		       ("loge" "log.error(\"==== [error]: {}\", e);"
			"loge" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/logsnippet/loge"
			nil nil)
		       ("log2"
			"log.info(\"==== [${1:parameter1}]: {}, [${2:parameter2}]: {}\", $0$1, $2);"
			"log2" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/logsnippet/log2"
			nil nil)))


;;; Snippet definitions:
;;;
(yas-define-snippets 'java-mode
		     '(("patl"
			"package `(mapconcat 'identity (split-string (replace-regexp-in-string \".*src\\\\(/\\\\(main\\\\|test\\\\)\\\\)?\\\\(/java\\\\)?\" \"\" default-directory) \"/\" t) \".\")`;\n\nimport lombok.Data;\nimport lombok.NoArgsConstructor;\nimport lombok.extern.slf4j.Slf4j;\n\n/**\n * @author `(getenv \"USER\")`\n * @time `(format-time-string \"%Y-%m-%d %H:%M:%S\")`\n **/\n@Data\n@Slf4j\n@NoArgsConstructor\npublic class `(file-name-sans-extension (buffer-name))` {\n\n    public static final ThreadLocal<String> YOUR_THD = ThreadLocal.withInitial(() -> {\n        return null;\n    });\n}"
			"threadlocal class" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/multhread/threadLocal"
			nil nil)
		       ("thread"
			"Thread t = new Thread($1) {\n    public void run() {\n        try {Thread.sleep(new Random().nextInt(10) * 1000L + 1000L);}\n        catch (InterruptedException e) {e.printStackTrace();}\n        $0\n    }\n};\nt.start();"
			"thread" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/multhread/thread"
			nil nil)
		       ("sleep"
			"try {Thread.sleep(new Random().nextInt(10) * 1000L + 1000L);}\ncatch (InterruptedException e) {e.printStackTrace();}"
			"sleep" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/multhread/sleep"
			nil nil)
		       ("cf"
			"CompletableFuture.supplyAsync(() -> {\n    try {\n        //TODO your thing\n        return true;\n    } catch (Exception e) {\n        log.error(\"{}\", e);\n        return false;\n    }\n});"
			"CompletableFuture" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/multhread/completableFuture"
			nil nil)))


;;; Snippet definitions:
;;;
(yas-define-snippets 'java-mode
		     '(("service"
			"package `(mapconcat 'identity (split-string (replace-regexp-in-string \".*src\\\\(/\\\\(main\\\\|test\\\\)\\\\)?\\\\(/java\\\\)?\" \"\" default-directory) \"/\" t) \".\")`;\n\nimport org.springframework.stereotype.Component;\n\nimport lombok.Data;\nimport lombok.NoArgsConstructor;\nimport lombok.extern.slf4j.Slf4j;\n\n/**\n * @author `(getenv \"USER\")`\n * @since `(format-time-string \"%Y-%m-%d %H:%M:%S\")`\n **/\n@Data\n@Slf4j\n@Component\n@NoArgsConstructor\npublic class `(file-name-sans-extension (buffer-name))` {\n\n    /**\n     * `(file-name-sans-extension (buffer-name))` service\n     */\n    public void service(){\n        log.info(\"==== [log]: {}\");\n    }\n\n}"
			"service" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/spring/service"
			nil nil)
		       ("reqmap"
			"	/**\n	 * 健康检查\n	 */\n	@RequestMapping(\"/healthCheck\")\n	public ResponseEntity<String> welcome() {\n		return ResponseEntity.ok(\"pong\");\n	}"
			"reqmap" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/spring/reqmap"
			nil nil)
		       ("fclient"
			"package `(mapconcat 'identity (split-string (replace-regexp-in-string \".*src\\\\(/\\\\(main\\\\|test\\\\)\\\\)?\\\\(/java\\\\)?\" \"\" default-directory) \"/\" t) \".\")`;\n\nimport org.springframework.cloud.openfeign.FeignClient;\n\n/**\n * @author `(getenv \"USER\")`\n * @since `(format-time-string \"%Y-%m-%d %H:%M:%S\")`\n **/\n@FeignClient(\n        contextId = \"`(file-name-sans-extension (buffer-name))`-api\",\n        name = \"${com.center.`(file-name-sans-extension (buffer-name))`:default-name}\",\n        url = \"${com.center.`(file-name-sans-extension (buffer-name))`.url:}\"\n)\npublic interface `(file-name-sans-extension (buffer-name))` {\n\n    /**\n     * `(file-name-sans-extension (buffer-name))` api interface\n     */\n    void api();\n}"
			"fclient" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/spring/fclient"
			nil nil)
		       ("ctl"
			"package `(mapconcat 'identity (split-string (replace-regexp-in-string \".*src\\\\(/\\\\(main\\\\|test\\\\)\\\\)?\\\\(/java\\\\)?\" \"\" default-directory) \"/\" t) \".\")`;\n\nimport javax.validation.Valid;\n\nimport org.springframework.beans.factory.annotation.Autowired;\nimport org.springframework.web.bind.annotation.GetMapping;\nimport org.springframework.web.bind.annotation.PostMapping;\nimport org.springframework.web.bind.annotation.RequestBody;\nimport org.springframework.web.bind.annotation.RequestMapping;\nimport org.springframework.web.bind.annotation.RestController;\n\n\nimport io.swagger.annotations.Api;\n\n/**\n * @author `(getenv \"USER\")`\n * @since `(format-time-string \"%Y-%m-%d %H:%M:%S\")`\n **/\n@Api(\"`(file-name-sans-extension (buffer-name))`\")\n@RestController\n@RequestMapping(\"`(file-name-sans-extension (buffer-name))`\")\npublic class `(file-name-sans-extension (buffer-name))` {\n\n    /**\n     * `(file-name-sans-extension (buffer-name))` post\n     */\n    @PostMapping(\"/post\")\n    public Result<Integer> post(@RequestBody @Valid Object postQo) {\n        return Result.success();\n    }\n\n    /**\n     * `(file-name-sans-extension (buffer-name))` get\n     */\n    @GetMapping(\"/get\")\n    public Result<Integer> get(@Valid Object getQo) {\n        return Result.success();\n    }\n\n}"
			"ctl" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/spring/controller"
			nil nil)
		       ("au" "@Autowired" "autowired" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/spring/autowired"
			nil nil)
		       ("aop"
			"package `(mapconcat 'identity (split-string (replace-regexp-in-string \".*src\\\\(/\\\\(main\\\\|test\\\\)\\\\)?\\\\(/java\\\\)?\" \"\" default-directory) \"/\" t) \".\")`;\n\nimport org.aopalliance.aop.Advice;\nimport org.aopalliance.intercept.MethodInterceptor;\nimport org.aopalliance.intercept.MethodInvocation;\nimport org.springframework.aop.Pointcut;\nimport org.springframework.aop.support.AbstractPointcutAdvisor;\nimport org.springframework.aop.support.annotation.AnnotationMatchingPointcut;\nimport org.springframework.stereotype.Component;\n\nimport lombok.extern.slf4j.Slf4j;\n\n/**\n * 自定义Advisor\n * @author `(getenv \"USER\")`\n * @since `(format-time-string \"%Y-%m-%d %H:%M:%S\")`\n **/\n@Slf4j\n@Component\npublic class `(file-name-sans-extension (buffer-name))` extends AbstractPointcutAdvisor {\n\n    @Override\n    public Pointcut getPointcut() {\n        // 引入注解切面\n        return AnnotationMatchingPointcut.forMethodAnnotation(`(file-name-sans-extension (buffer-name))`Ins.class);\n    }\n\n    @Override\n    public Advice getAdvice() {\n        return new MethodInterceptor() {\n\n            @Override\n            public Object invoke(MethodInvocation invocation) throws Throwable {\n                log.info(\"\\n==== [log]: {}\", \"进入切面\");\n                Object result = invocation.proceed();\n                return result;\n            }\n        };\n    }\n}"
			"aop" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/spring/aop"
			nil nil)))


;;; Snippet definitions:
;;;
(yas-define-snippets 'java-mode
		     '(("test"
			"/**\n * $0mvn test -Dtest=`(mapconcat 'identity (split-string (replace-regexp-in-string \".*src\\\\(/\\\\(main\\\\|test\\\\)\\\\)?\\\\(/java\\\\)?\" \"\" default-directory) \"/\" t) \".\")`.`(file-name-sans-extension (buffer-name))`#${1:testName}\n */\n@Test\npublic void ${1:testName}() {\n    $0\n}"
			"test" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/tests/test"
			nil nil)
		       ("mvnt"
			"$0mvnj8 -Dtest=`(mapconcat 'identity (split-string (replace-regexp-in-string \".*src\\\\(/\\\\(main\\\\|test\\\\)\\\\)?\\\\(/java\\\\)?\" \"\" default-directory) \"/\" t) \".\")`.`(file-name-sans-extension (buffer-name))`#`(yank)` test"
			"mvntest" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/tests/mvntest"
			nil nil)))


;;; Snippet definitions:
;;;
(yas-define-snippets 'java-mode
		     '(("tostring"
			"@Override\npublic String toString() {\n    return JSON.toJSONString(this);\n}\n"
			"toString" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/utils/toString"
			nil nil)
		       ("2stream"
			"InputStream targetStream = new ByteArrayInputStream(str.getBytes());"
			"2stream" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/utils/string2stream"
			nil nil)
		       ("2str"
			"InputStream stream;\nbyte[] bytes = new byte[stream.available()];\nstream.read(bytes);\nString str = new String(bytes);"
			"2str" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/utils/stream2str"
			nil nil)
		       ("match"
			"Pattern pattern = Pattern.compile(\"<MessageBody>([\\\\s\\\\S]*)</MessageBody>\");\nMatcher matcher = pattern.matcher(str);\nif (matcher.find()) {\n    String group = matcher.group(1);\n    int start = group.indexOf(\"{\");\n    int end = group.lastIndexOf(\"}\");\n    if (start > -1 && end > -1) {\n        str = str.replaceFirst(Pattern.quote(group), group.substring(start, end + 1));\n    }\n}"
			"match" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/utils/match"
			nil nil)
		       ("diffdate"
			"Calendar start = Calendar.getInstance();\nlog.info(\"\\n====[consume]: {}ms\",  Calendar.getInstance().getTimeInMillis() - start.getTimeInMillis());"
			"diffDate" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/utils/diffDate"
			nil nil)
		       ("ie"
			"if (!StringUtils.isEmpty(${1:value})) {\n    $0\n}"
			"Stringuitls" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/utils/Stringuitls"
			nil nil)
		       ("datestr"
			"String dateStr = new SimpleDateFormat(\"yyyy-MM-dd HH:mm:ss\").format(new Date());\nlog.info(\"\\n==== [log]: {}\", dateStr);"
			"DateStr" nil nil nil
			"/Users/hc/.config/emacs/snippets/java-mode/utils/DateStr"
			nil nil)))


;;; Do not edit! File generated at Sat Jun 27 15:06:27 2026
