;;; "Compiled" snippets and support files for `sh-mode'  -*- lexical-binding:t -*-
;;; Snippet definitions:
;;;
(yas-define-snippets 'sh-mode
		     '(("run"
			"#!/bin/bash\nset -e\nexport TZ=\"Asia/Shanghai\"\nps -ef | grep app | awk '{print $2}' | xargs kill -9\nmvnj11 clean package -U -DskipTests\n\n$JAVA_11_ARM_HOME/bin/java \\\n-Xms124m -Xmx512m \\\n-agentpath:/Users/van/ZY/workspace/jrebel/lib/libjrebel64.dylib \\\n--spring.profiles.active=local \\\n--spring.cloud.nacos.config.enabled=false \\\n--spring.cloud.nacos.discovery.enabled=false \\\n-Dlogging.level.com.baomidou.mybatisplus=DEBUG \\\n-Dmybatis-plus.configuration.log-impl=org.apache.ibatis.logging.stdout.StdOutImpl \\\n-jar target/app-1.0.0-SNAPSHOT.jar"
			"run" nil nil nil
			"/Users/hc/.config/emacs/snippets/sh-mode/run"
			nil nil)
		       ("kill"
			"ps -ef | grep $0 | awk '{print \\$2}' | xargs kill -9"
			"kill" nil nil nil
			"/Users/hc/.config/emacs/snippets/sh-mode/kill"
			nil nil)
		       ("java8" "export JAVA_HOME=$JAVA_8_HOME\n"
			"java8" nil nil nil
			"/Users/hc/.config/emacs/snippets/sh-mode/java8"
			nil nil)))


;;; Do not edit! File generated at Sat Jun 27 15:06:27 2026
