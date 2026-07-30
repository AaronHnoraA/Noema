;;; "Compiled" snippets and support files for `yaml-mode'  -*- lexical-binding:t -*-
;;; Snippet definitions:
;;;
(yas-define-snippets 'yaml-mode
		     '(("mybatisc"
			"spring:\n  datasource:\n    driver-class-name: com.mysql.jdbc.Driver\n    url: jdbc:mysql://myjrebel.cn:3306/spring?useSSL=false\n    username: root\n    password: ***\n\n# mybatis配置\nmybatis:\n  mapper-locations: classpath:mapper/*.xml    # mapper映射文件位置\n  type-aliases-package: com.demo.entity;    # 实体类所在的位置\n  configuration:\n    log-impl: org.apache.ibatis.logging.stdout.StdOutImpl   #用于控制台打印sql语句"
			"mybatisc" nil nil nil
			"/Users/hc/.config/emacs/snippets/yaml-mode/mybatisc"
			nil nil)
		       ("aiderconf"
			"no-auto-commits: true\nmax-chat-history: 6\n\nread:\n  - CONVENTIONS.md\n\nmodel: deepseek/deepseek-chat\n"
			"aiderconf" nil nil nil
			"/Users/hc/.config/emacs/snippets/yaml-mode/aiderconfig"
			nil nil)))


;;; Do not edit! File generated at Sat Jun 27 15:06:27 2026
