import 'package:flutter/material.dart';
import '../theme/app_colors.dart';
import '../widgets/app_status_bar.dart';
import '../widgets/search_pill_bar.dart';
import '../widgets/pill_chip.dart';

/// Screen 6 — Semantic Search results.
class SearchScreen extends StatelessWidget {
  const SearchScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      color: cs.surface,
      child: SafeArea(
        bottom: false,
        child: Column(
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
                      'Search',
                      style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
                    ),
                  ),
                ],
              ),
            ),
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 16),
              child: SearchPillBar(value: 'tax 2024'),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
              child: Align(
                alignment: Alignment.centerLeft,
                child: RichText(
                  text: TextSpan(
                    style: TextStyle(
                        fontSize: 11,
                        color: cs.onSurface.withOpacity(0.55)),
                    children: const [
                      TextSpan(text: 'AI understood: '),
                      TextSpan(
                        text: 'tax-related PDFs from 2024',
                        style: TextStyle(
                            color: AppColors.lightOnSurface, fontWeight: FontWeight.w600),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            const SizedBox(height: 6),
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 16),
              child: Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  PillChip(label: 'PDF',       badge: 12),
                  PillChip(label: '2024',      badge: 8),
                  PillChip(label: 'Documents', badge: 12),
                  PillChip(label: 'Images',    badge: 4),
                ],
              ),
            ),
            const SizedBox(height: 14),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                children: const [
                  _ResultCard(
                    type: _FileTypeEx.pdf,
                    name: 'Tax-Returns-2024.pdf',
                    meta: 'Documents · 4.2 MB · Apr 12, 2024',
                    snippet:
                        '"Tax Return Form 1040 — filed for year 2024. Contains W-2 ..."',
                    starred: true,
                  ),
                  _ResultCard(
                    type: _FileTypeEx.pdf,
                    name: 'State-Taxes-CA-2024.pdf',
                    meta: 'Documents · 1.8 MB · Mar 28, 2024',
                    snippet:
                        '"Taxes for California — filed in 2024. Schedule C attached."',
                  ),
                  _ResultCard(
                    type: _FileTypeEx.doc,
                    name: 'Tax-Notes-Misc.docx',
                    meta: 'Downloads · 86 KB · Dec 14, 2024',
                    snippet:
                        '"Notes about tax deductions for 2024 filing."',
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

enum _FileTypeEx { pdf, doc }

class _ResultCard extends StatelessWidget {
  const _ResultCard({
    required this.type,
    required this.name,
    required this.meta,
    required this.snippet,
    this.starred = false,
  });
  final _FileTypeEx type;
  final String      name;
  final String      meta;
  final String      snippet;
  final bool        starred;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final color = type == _FileTypeEx.pdf ? AppColors.pdfRed : AppColors.docBlue;
    final label = type == _FileTypeEx.pdf ? 'PDF' : 'DOC';

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: cs.surface,
        border: Border.all(color: cs.outline),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: color,
                  borderRadius: BorderRadius.circular(8),
                ),
                alignment: Alignment.center,
                child: Text(
                  label,
                  style: const TextStyle(
                      fontSize: 9,
                      fontWeight: FontWeight.w700,
                      color: Colors.white),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(name, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                    Text(meta,
                        style: TextStyle(
                            fontSize: 11,
                            color: cs.onSurface.withOpacity(0.55))),
                  ],
                ),
              ),
              Icon(
                starred ? Icons.star : Icons.star_border,
                size: 18,
                color: starred ? AppColors.primary : cs.onSurface.withOpacity(0.4),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.only(top: 8),
            decoration: BoxDecoration(
              border: Border(top: BorderSide(color: cs.outline)),
            ),
            child: _HighlightedSnippet(text: snippet, cs: cs),
          ),
        ],
      ),
    );
  }
}

/// Highlights query-like tokens (case-insensitive) with a soft amber background.
class _HighlightedSnippet extends StatelessWidget {
  const _HighlightedSnippet({required this.text, required this.cs});
  final String      text;
  final ColorScheme cs;

  static final _regex = RegExp(
    r'(Tax|taxes|tax|2024)',
    caseSensitive: false,
  );

  @override
  Widget build(BuildContext context) {
    final base = TextStyle(
      fontSize: 11,
      color: cs.onSurface.withOpacity(0.7),
      height: 1.4,
    );
    const hl = TextStyle(
      backgroundColor: Color(0xFFFEF3C7),
      color: Color(0xFF92400E),
    );
    final spans = <TextSpan>[];
    var cursor = 0;
    for (final m in _regex.allMatches(text)) {
      if (m.start > cursor) {
        spans.add(TextSpan(text: text.substring(cursor, m.start), style: base));
      }
      spans.add(TextSpan(text: text.substring(m.start, m.end), style: hl));
      cursor = m.end;
    }
    if (cursor < text.length) {
      spans.add(TextSpan(text: text.substring(cursor), style: base));
    }
    return RichText(text: TextSpan(style: base, children: spans));
  }
}
