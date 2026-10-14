from pypdf import PdfReader
r = PdfReader("2026-2027-1：习思想题库汇总（20261010）.pdf")
print("pages:", len(r.pages))
with open("tools/pdf_text.txt","w",encoding="utf-8") as f:
    for i,p in enumerate(r.pages):
        f.write(f"\n===== PAGE {i+1} =====\n")
        f.write(p.extract_text() or "")
