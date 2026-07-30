;;; "Compiled" snippets and support files for `nxml-mode'  -*- lexical-binding:t -*-
;;; Snippet definitions:
;;;
(yas-define-snippets 'nxml-mode
		     '(("testp"
			"<plugin>\n    <groupId>org.apache.maven.plugins</groupId>\n    <artifactId>maven-surefire-plugin</artifactId>\n    <version>3.0.0-M7</version>\n    <dependencies>\n        <dependency>\n            <groupId>org.junit.jupiter</groupId>\n            <artifactId>junit-jupiter-engine</artifactId>\n            <version>5.6.2</version>\n        </dependency>\n    </dependencies>\n</plugin>\n"
			"test-plug-dependency" nil nil nil
			"/Users/hc/.config/emacs/snippets/nxml-mode/test-plugin"
			nil nil)
		       ("test"
			"<dependency>\n    <groupId>org.springframework.boot</groupId>\n    <artifactId>spring-boot-starter-test</artifactId>\n    <scope>test</scope>\n</dependency>\n<dependency>\n    <groupId>org.junit.jupiter</groupId>\n    <artifactId>junit-jupiter-api</artifactId>\n    <version>5.6.2</version>\n    <scope>test</scope>\n</dependency>\n<dependency>\n    <groupId>junit</groupId>\n    <artifactId>junit</artifactId>\n    <version>4.13</version>\n    <scope>test</scope>\n</dependency>\n<dependency>\n    <groupId>org.junit.jupiter</groupId>\n    <artifactId>junit-jupiter-engine</artifactId>\n    <version>5.6.2</version>\n    <scope>test</scope>\n</dependency>\n<dependency>\n    <groupId>org.junit.vintage</groupId>\n    <artifactId>junit-vintage-engine</artifactId>\n    <version>5.6.2</version>\n    <scope>test</scope>\n</dependency>"
			"test" nil nil nil
			"/Users/hc/.config/emacs/snippets/nxml-mode/test"
			nil nil)
		       ("rebel"
			"<application\n    generated-by       = \"maven\"\n    build-tool-version = \"3.6.1\"\n    plugin-version     = \"1.1.10\"\n    xmlns              = \"http://www.zeroturnaround.com\"\n    xmlns:xsi          = \"http://www.w3.org/2001/XMLSchema-instance\"\n    xsi:schemaLocation = \"http://www.zeroturnaround.com http://update.zeroturnaround.com/jrebel/rebel-2_2.xsd\">\n<classpath>\n    <dir name=\\\"$\\{user.dir\\}/target/classes\\\"></dir>\n</classpath>\n</application>"
			"rebel" nil nil nil
			"/Users/hc/.config/emacs/snippets/nxml-mode/rebel"
			nil nil)
		       ("mvn-versions"
			"<plugin>\n    <groupId>org.codehaus.mojo</groupId>\n    <artifactId>versions-maven-plugin</artifactId>\n    <version>2.11.0</version>\n</plugin>\n"
			"mvn-versions" nil nil nil
			"/Users/hc/.config/emacs/snippets/nxml-mode/maven-versions"
			nil nil)
		       ("mvnex"
			"<exclusions>\n    <exclusion>\n        <groupId></groupId>\n        <artifactId></artifactId>\n    </exclusion>\n</exclusions>"
			"mvnex" nil nil nil
			"/Users/hc/.config/emacs/snippets/nxml-mode/maven-exclusion"
			nil nil)
		       ("mvnplugin"
			"    <build>\n        <plugins>\n            <plugin>\n                <groupId>org.springframework.boot</groupId>\n                <artifactId>spring-boot-maven-plugin</artifactId>\n            </plugin>\n            <plugin>\n                <groupId>org.springframework.boot</groupId>\n                <artifactId>spring-boot-maven-plugin</artifactId>\n                <configuration>\n                    <includeSystemScope>true</includeSystemScope>\n                </configuration>\n            </plugin>\n            <!-- <plugin> -->\n            <!--     <artifactId>maven-dependency-plugin</artifactId> -->\n            <!--     <version>${maven-dependency-plugin.version}</version> -->\n            <!-- </plugin> -->\n            <!-- <plugin> -->\n            <!--     <groupId>org.apache.maven.plugins</groupId> -->\n            <!--     <artifactId>maven-compiler-plugin</artifactId> -->\n            <!--     <version>3.7.0</version> -->\n            <!--     <configuration> -->\n            <!--         <source>1.8</source> -->\n            <!--         <target>1.8</target> -->\n            <!--         <encoding>UTF-8</encoding> -->\n            <!--     </configuration> -->\n            <!-- </plugin> -->\n        </plugins>\n    </build>"
			"mvnplugin" nil nil nil
			"/Users/hc/.config/emacs/snippets/nxml-mode/maven-complie"
			nil nil)
		       ("build"
			"<build>\n    <finalName>${project.artifactId}</finalName>\n    <plugins>\n        <plugin>\n            <groupId>org.springframework.boot</groupId>\n            <artifactId>spring-boot-maven-plugin</artifactId>\n        </plugin>\n        <plugin>\n            <artifactId>maven-dependency-plugin</artifactId>\n            <version>${maven-dependency-plugin.version}</version>\n        </plugin>\n        <plugin>\n            <groupId>org.apache.maven.plugins</groupId>\n            <artifactId>maven-compiler-plugin</artifactId>\n            <version>3.7.0</version>\n            <configuration>\n                <source>1.8</source>\n                <target>1.8</target>\n                <encoding>UTF-8</encoding>\n            </configuration>\n        </plugin>\n    </plugins>\n</build>"
			"build" nil nil nil
			"/Users/hc/.config/emacs/snippets/nxml-mode/maven-build"
			nil nil)
		       ("lombok"
			"<dependency>\n    <groupId>org.projectlombok</groupId>\n    <artifactId>lombok</artifactId>\n    <version>${1.18.16}</version>\n    <scope>provided</scope>\n</dependency>"
			"lombok" nil nil nil
			"/Users/hc/.config/emacs/snippets/nxml-mode/lombok"
			nil nil)
		       ("logback"
			"<?xml version=\"1.0\" encoding=\"utf-8\"?>\n\n<configuration>\n    <property name=\"LOG_PATTERN\" value=\"%date %-5level --- [%thread] %class.%method:%line : %msg%n\"/>\n    <property name=\"LOG_PATTERN_COLOURS\" value=\"%green(%date) %highlight(%-5level) --- [%thread] %cyan(%class.%method:%blue(%line)) : %msg%n\"/>\n    <springProperty scope=\"context\" name=\"logger.stdfilepath\" source=\"logger.stdfilepath\" defaultValue=\"./logs/info.log\"/>\n    <springProperty scope=\"context\" name=\"logger.errorfilepath\" source=\"logger.errorfilepath\" defaultValue=\"./logs/error.log\"/>\n    <springProperty scope=\"context\" name=\"logger.zipfilepath\" source=\"logger.zipfilepath\" defaultValue=\"./logs/info_%d{yyyy-MM-dd}_%i.zip\"/>\n    <springProperty scope=\"context\" name=\"logger.errorzipfilepath\" source=\"logger.errorzipfilepath\" defaultValue=\"./logs/error_%d{yyyy-MM-dd}_%i.zip\"/>\n\n    <appender name=\"STDOUT\" class=\"ch.qos.logback.core.ConsoleAppender\">\n        <encoder>\n            <pattern>${LOG_PATTERN_COLOURS}</pattern>\n            <charset>UTF-8</charset>\n        </encoder>\n    </appender>\n\n    <appender name=\"STD-ROLLING\" class=\"ch.qos.logback.core.rolling.RollingFileAppender\">\n        <File>${logger.stdfilepath}</File>\n        <rollingPolicy class=\"ch.qos.logback.core.rolling.SizeAndTimeBasedRollingPolicy\">\n            <fileNamePattern>${logger.zipfilepath}</fileNamePattern>\n            <maxFileSize>50MB</maxFileSize>\n            <maxHistory>30</maxHistory>\n            <totalSizeCap>1GB</totalSizeCap>\n        </rollingPolicy>\n        <encoder>\n            <pattern>${LOG_PATTERN}</pattern>\n            <charset>UTF-8</charset>\n        </encoder>\n    </appender>\n\n    <appender name=\"ERROR-ROLLING\" class=\"ch.qos.logback.core.rolling.RollingFileAppender\">\n        <File>${logger.errorfilepath}</File>\n        <filter class=\"ch.qos.logback.classic.filter.ThresholdFilter\">\n            <level>ERROR</level>\n        </filter>\n\n        <rollingPolicy class=\"ch.qos.logback.core.rolling.SizeAndTimeBasedRollingPolicy\">\n            <fileNamePattern>${logger.errorzipfilepath}</fileNamePattern>\n            <maxFileSize>50MB</maxFileSize>\n            <maxHistory>30</maxHistory>\n            <totalSizeCap>1GB</totalSizeCap>\n        </rollingPolicy>\n        <encoder>\n            <pattern>${LOG_PATTERN}</pattern>\n            <charset>UTF-8</charset>\n        </encoder>\n    </appender>\n\n    <logger name=\"com.alibaba.nacos\" level=\"error\"/>\n\n    <springProfile name=\"!prod\">\n        <root level=\"info\">\n            <appender-ref ref=\"STDOUT\"/>\n            <appender-ref ref=\"STD-ROLLING\"/>\n            <appender-ref ref=\"ERROR-ROLLING\"/>\n        </root>\n        <logger name=\"jdbc.sqltiming\"             level=\"debug\"/>\n        <logger name=\"java.sql.Connection\"        level=\"debug\"/>\n        <logger name=\"java.sql.Statement\"         level=\"debug\"/>\n        <logger name=\"java.sql.PreparedStatement\" level=\"debug\"/>\n        <logger name=\"com.ibatis\"                 level=\"debug\"/>\n    </springProfile>\n\n    <springProfile name=\"prod\">\n        <root level=\"info\">\n            <appender-ref ref=\"STDOUT\"/>\n            <appender-ref ref=\"STD-ROLLING\"/>\n            <appender-ref ref=\"ERROR-ROLLING\"/>\n        </root>\n    </springProfile>\n\n</configuration>"
			"logback" nil nil nil
			"/Users/hc/.config/emacs/snippets/nxml-mode/logback"
			nil nil)
		       ("junit"
			"<dependency>\n    <groupId>org.springframework.boot</groupId>\n    <artifactId>spring-boot-starter-test</artifactId>\n    <scope>test</scope>\n</dependency>"
			"junit" nil nil nil
			"/Users/hc/.config/emacs/snippets/nxml-mode/junit"
			nil nil)
		       ("json"
			"<dependency>\n    <groupId>com.alibaba</groupId>\n    <artifactId>fastjson</artifactId>\n    <version>1.2.75</version>\n</dependency>"
			"json" nil nil nil
			"/Users/hc/.config/emacs/snippets/nxml-mode/json"
			nil nil)
		       ("hutool"
			"<dependency>\n    <groupId>cn.hutool</groupId>\n    <artifactId>hutool-all</artifactId>\n    <version>5.8.0.M2</version>\n</dependency>"
			"hutool" nil nil nil
			"/Users/hc/.config/emacs/snippets/nxml-mode/hutool"
			nil nil)))


;;; Do not edit! File generated at Sat Jun 27 15:06:27 2026
