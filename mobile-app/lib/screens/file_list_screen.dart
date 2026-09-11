import 'package:flutter/material.dart';
import '../theme/app_colors.dart';
import '../widgets/app_status_bar.dart';
import '../widgets/file_tile.dart';

/// Screen 3 — File List · Multi-select.
class FileListScreen extends StatelessWidget {
  const FileListScreen({super.key});

  static const List<(FileType, String, String)> _files = [
    (FileType.pdf,  'CS-Lecture-Notes-W3.pdf',     'Documents · 2.4 MB · Today'),
    (FileType.pdf,  'Math-HW-Solutions.pdf',       'Documents · 1.6 MB · Yesterday'),
    (FileType.doc,  'Group-Project-Proposal.docx', 'Documents · 482 KB · 2 days ago'),
    (FileType.xls,  'Budget-Tracker-Q4.xlsx',      'Documents · 312 KB · Last week'),
    (FileType.ppt,  'Final-Presentation.pptx',     'Documents · 8.7 MB · 3 days ago'),
    (FileType.pdf,  'Tax-Forms-2024.pdf',          'Documents · 8.5 MB · Mar 12'),
    (FileType.doc,  'Resume-Final.docx',           'Documents · 218 KB · Feb 28'),
  ];

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      color: cs.surface,
      child: SafeArea(
        bottom: false,
        child: Stack(
          children: [
            Column(
              children: [
                const AppStatusBar(),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                  child: Row(
                    children: [
                      IconButton(
                        onPressed: () => Navigator.of(context).maybePop(),
                        icon: const Icon(Icons.arrow_back),
                      ),
                      const Expanded(
                        child: Text(
                          'Documents',
                          style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
                        ),
                      ),
                      IconButton(onPressed: () {}, icon: const Icon(Icons.delete_outline)),
                      IconButton(onPressed: () {}, icon: const Icon(Icons.more_vert)),
                    ],
                  ),
                ),
                Container(
                  color: cs.primaryContainer,
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      RichText(
                        text: TextSpan(
                          style: TextStyle(
                            color: cs.primary,
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                          ),
                          children: const [
                            TextSpan(text: '4 selected', style: TextStyle(fontWeight: FontWeight.w700)),
                            TextSpan(text: ' · 12.8 MB'),
                          ],
                        ),
                      ),
                      Text(
                        'Clear',
                        style: TextStyle(
                          color: cs.primary,
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: ListView.separated(
                    padding: const EdgeInsets.fromLTRB(16, 4, 16, 120),
                    itemCount: _files.length,
                    separatorBuilder: (_, __) =>
                        Divider(height: 1, color: cs.outline),
                    itemBuilder: (_, i) => FileTile(
                      name: _files[i].$2,
                      meta: _files[i].$3,
                      type: _files[i].$1,
                      selected: i == 0 || i == 1 || i == 3 || i == 5,
                    ),
                  ),
                ),
              ],
            ),
            Positioned(
              left: 0,
              right: 0,
              bottom: 72,
              child: Container(
                decoration: BoxDecoration(
                  color: cs.surface,
                  border: Border(top: BorderSide(color: cs.outline)),
                ),
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 10),
                child: const Row(
                  children: [
                    _ActionBar(icon: Icons.arrow_forward,   label: 'Move',   primary: true),
                    _ActionBar(icon: Icons.share_outlined, label: 'Share'),
                    _ActionBar(icon: Icons.delete_outline, label: 'Delete'),
                    _ActionBar(icon: Icons.edit_outlined,  label: 'Rename'),
                  ],
                ),
              ),
            ),
            Positioned(
              right: 80,
              bottom: 80,
              child: Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  color: cs.surface,
                  border: Border.all(color: cs.outline),
                  borderRadius: BorderRadius.circular(14),
                  boxShadow: const [
                    BoxShadow(color: Color(0x14000000), blurRadius: 12, offset: Offset(0, 4)),
                  ],
                ),
                child: const Icon(Icons.mic, color: AppColors.primary),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ActionBar extends StatelessWidget {
  const _ActionBar({required this.icon, required this.label, this.primary = false});
  final IconData icon;
  final String   label;
  final bool     primary;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final color = primary ? cs.primary : cs.onSurface.withOpacity(0.7);
    return Expanded(
      child: Column(
        children: [
          Icon(icon, size: 18, color: color),
          const SizedBox(height: 4),
          Text(label,
              style: TextStyle(fontSize: 10, fontWeight: FontWeight.w600, color: color)),
        ],
      ),
    );
  }
}
