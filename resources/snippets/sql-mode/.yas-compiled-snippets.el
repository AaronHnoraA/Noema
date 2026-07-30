;;; "Compiled" snippets and support files for `sql-mode'  -*- lexical-binding:t -*-
;;; Snippet definitions:
;;;
(yas-define-snippets 'sql-mode
		     '(("update"
			"<select name='update $0`(yank)`'>\n UPDATE $0`(yank)` SET id=$1 WHERE id=$2;\n</select>"
			"update" nil nil nil
			"/Users/hc/.config/emacs/snippets/sql-mode/update"
			nil nil)
		       ("tables"
			"<select name='搜索表名'>\nSELECT TABLE_NAME\nFROM  INFORMATION_SCHEMA.TABLES\nWHERE TABLE_SCHEMA = ':CHEMA_NAME'\nAND TABLE_NAME LIKE  '%:TABLE_NAME%'\nLIMIT 0,10\n</select>"
			"tables" nil nil nil
			"/Users/hc/.config/emacs/snippets/sql-mode/tables"
			nil nil)
		       ("tc"
			"<select name='查看表 $0`(yank)` 注释'>\nSELECT TABLE_NAME , table_comment\nFROM information_schema.TABLES\nWHERE TABLE_NAME LIKE '%$0`(yank)`%'\n</select>\n"
			"tc" nil nil nil
			"/Users/hc/.config/emacs/snippets/sql-mode/tabledesc"
			nil nil)
		       ("showindex"
			"<select name='show $0`(yank)` index '>\nSHOW INDEX FROM $0`(yank)`\n</select>"
			"showindex" nil nil nil
			"/Users/hc/.config/emacs/snippets/sql-mode/showindex"
			nil nil)
		       ("schema"
			"<select name='搜索库名'>\nSELECT schema_name FROM information_schema.schemata\nwhere schema_name like '%$0%'\n</select>\n"
			"schema" nil nil nil
			"/Users/hc/.config/emacs/snippets/sql-mode/schemas"
			nil nil)
		       ("schemarp"
			"-- <Waring message=\"不同库之间进行库名的切换\">\n-- dev: dbA\n-- 替换方式 4,$s/dbA/dbB/g"
			"schemarp" nil nil nil
			"/Users/hc/.config/emacs/snippets/sql-mode/replace-schema"
			nil nil)
		       ("process"
			"<select name='process sql'>\nshow full processlist;\n</select>"
			"process" nil nil nil
			"/Users/hc/.config/emacs/snippets/sql-mode/process"
			nil nil)
		       ("rn" "where 1=1 and rownum=1" "oracle-limit"
			nil nil nil
			"/Users/hc/.config/emacs/snippets/sql-mode/oracle-limit"
			nil nil)
		       ("modify"
			"<select name='modify $0`(yank)`'>\n ALTER TABLE $0`(yank)` MODIFY user_name varchar(200)  NOT NULL DEFAULT '-1' COMMENT '';\n</select>"
			"modify" nil nil nil
			"/Users/hc/.config/emacs/snippets/sql-mode/modify"
			nil nil)
		       ("join"
			"<select name='select_join'>\n    SELECT * FROM ${1:table_a} $1\n    LEFT     JOIN ${2:table_b} $2\n    ON       $1.id = $2.id\n    WHERE    $1.id IS NOT NULL\n    ORDER BY $1.id DESC\n    LIMIT 1\n</select>"
			"join" nil nil nil
			"/Users/hc/.config/emacs/snippets/sql-mode/join"
			nil nil)
		       ("ejc"
			"<select name='$0`(yank)` select'>\n SELECT * FROM $0`(yank)` LIMIT 1\n</select>"
			"ejc" nil nil nil
			"/Users/hc/.config/emacs/snippets/sql-mode/ejc"
			nil nil)
		       ("dl" "delimiter ;" "dl" nil nil nil
			"/Users/hc/.config/emacs/snippets/sql-mode/dl"
			nil nil)
		       ("dc"
			"<select name='表结构查询'>\nSELECT DISTINCT c.column_name , c.is_nullable,\nc.column_default, c.column_type,\nCASE c.column_name\nWHEN 'id' THEN concat('〖',t.table_name,'〗=〖',table_comment, '〗\\t',c.column_comment)\nELSE c.column_comment END AS column_comment\nFROM      information_schema.TABLES  t\nLEFT JOIN information_schema.COLUMNS c\nON      t.TABLE_NAME = c.TABLE_NAME\nWHERE c.table_name   = '$0:TABLE_NAME'\nAND   t.TABLE_SCHEMA = '$1:SCHEMA_NAME'\n</select>"
			"dc" nil nil nil
			"/Users/hc/.config/emacs/snippets/sql-mode/desctable"
			nil nil)
		       ("delete"
			"<select name='delete $0`(yank)`'>\n DELETE FROM $0`(yank)`\n WHERE id=$1\n LIMIT 1\n</select>\n"
			"delete" nil nil nil
			"/Users/hc/.config/emacs/snippets/sql-mode/delete"
			nil nil)
		       ("dv"
			"<select name='default_value'>\nselect default($0) as default_value from $1 limit 1;\n</select>"
			"dv" nil nil nil
			"/Users/hc/.config/emacs/snippets/sql-mode/defaultvalue"
			nil nil)
		       ("ddl"
			"<select name='ddl $0`(yank)`'>\nSHOW CREATE TABLE $0`(yank)`;\n</select>"
			"ddl" nil nil nil
			"/Users/hc/.config/emacs/snippets/sql-mode/ddl"
			nil nil)
		       ("c2"
			"<select name='create_table'>\n CREATE TABLE table (\n  id      BIGINT        PRIMARY KEY,\n  name    VARCHAR(64)   DEFAULT NULL COMMENT '名称',\n  code    VARCHAR(64)   DEFAULT NULL COMMENT '编码',\n  typec   TINYINT       DEFAULT NULL COMMENT '类型',\n  UNIQUE KEY            IDX_UNQ     (code, typec),\n  KEY                   IDX_TYPEC   (typec)\n ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COMMENT='TABLE'\n</select>"
			"create" nil nil nil
			"/Users/hc/.config/emacs/snippets/sql-mode/create"
			nil nil)
		       ("copy"
			"<select name='$0`(yank)` copy'>\n  INSERT INTO `(yank)`\n  SELECT\n  id\n  FROM `(yank)`\n  where id=\n  LIMIT 1;\n</select>"
			"copy" nil nil nil
			"/Users/hc/.config/emacs/snippets/sql-mode/copy"
			nil nil)
		       ("ble"
			"<select name='empty block'>\n   $0\n</select>"
			"ble" nil nil nil
			"/Users/hc/.config/emacs/snippets/sql-mode/ble"
			nil nil)
		       ("bl"
			"<select name='select block'>\n SELECT * FROM $0 LIMIT 1\n</select>"
			"bl" nil nil nil
			"/Users/hc/.config/emacs/snippets/sql-mode/bl"
			nil nil)
		       ("add"
			"<select name='$0`(yank)` alter_add'>\n ALTER TABLE $0`(yank)` ADD typec   tinyint    NOT NULL COMMENT '权限数据类型 1. 组织 2. 员工 ';\n ALTER TABLE $0`(yank)` ADD data_id bigint(20) NOT NULL COMMENT '数据id';\n</select>"
			"add" nil nil nil
			"/Users/hc/.config/emacs/snippets/sql-mode/add"
			nil nil)))


;;; Do not edit! File generated at Sat Jun 27 15:06:27 2026
