import os

# 定义要查找和替换的特征字符串
SEARCH_TEXT = '(when (and (not (eobp)) (looking-at "\n")) (let ((inhibit-modification-hooks t)) (ignore-errors (delete-blank-lines))))'
REPLACE_TEXT = '(when (and (not (eobp)) (looking-at "\n")) (let ((inhibit-modification-hooks t)) (ignore-errors (delete-char 1))))'

def batch_replace():
    # 获取脚本自身的文件名，避免自残
    script_name = os.path.basename(__file__)
    count = 0

    for root, dirs, files in os.walk('.'):
        for file_name in files:
            # 跳过脚本自己
            if file_name == script_name:
                continue

            file_path = os.path.join(root, file_name)
            
            try:
                # 读取内容
                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read()

                # 如果内容中包含目标字符串，则进行替换
                if SEARCH_TEXT in content:
                    new_content = content.replace(SEARCH_TEXT, REPLACE_TEXT)
                    
                    with open(file_path, 'w', encoding='utf-8') as f:
                        f.write(new_content)
                    
                    print(f"已处理: {file_path}")
                    count += 1
            except Exception as e:
                print(f"无法处理 {file_path}: {e}")

    print(f"\n任务完成！共修改了 {count} 个文件。")

if __name__ == "__main__":
    batch_replace()
