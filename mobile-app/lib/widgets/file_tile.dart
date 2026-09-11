import 'package:flutter/material.dart';
import '../theme/app_colors.dart';

/// File-type enum — drives both the colored shortcut pill and the abbreviation.
enum FileType {
  pdf, image, doc, xls, ppt, apk, audio, video, chat
}

class FileTile extends StatelessWidget {
  const FileTile({
    super.key,
    required this.name,
    required this.meta,
    required this.type,
    this.selected = false,
    this.onTap,
  });

  final String   name;
  final String   meta;
  final FileType type;
  final bool     selected;
  final VoidCallback? onTap;

  Color get _bg {
    switch (type) {
      case FileType.pdf:   return AppColors.pdfRed;
      case FileType.image: return AppColors.imageGreen;
      case FileType.doc:   return AppColors.docBlue;
      case FileType.xls:   return AppColors.xlsGreen;
      case FileType.ppt:   return AppColors.pptPurple;
      case FileType.apk:   return AppColors.success;
      case FileType.audio: return AppColors.tertiary;
      case FileType.video: return AppColors.warning;
      case FileType.chat:  return AppColors.secondary;
    }
  }

  String get _abbrev {
    switch (type) {
      case FileType.pdf:   return 'PDF';
      case FileType.image: return 'IMG';
      case FileType.doc:   return 'DOC';
      case FileType.xls:   return 'XLS';
      case FileType.ppt:   return 'PPT';
      case FileType.apk:   return 'APK';
      case FileType.audio: return 'AUD';
      case FileType.video: return 'VID';
      case FileType.chat:  return 'CHT';
    }
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 10),
        child: Row(
          children: [
            Container(
              width: 40,
              height: 40,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: _bg,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Text(
                _abbrev,
                style: const TextStyle(
                  fontSize: 10,
                  fontWeight: FontWeight.w700,
                  color: Colors.white,
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    name,
                    overflow: TextOverflow.ellipsis,
                    maxLines: 1,
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: selected ? cs.primary : cs.onSurface,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    meta,
                    style: TextStyle(
                      fontSize: 11,
                      color: cs.onSurface.withOpacity(0.55),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            _CheckMark(checked: selected),
          ],
        ),
      ),
    );
  }
}

class _CheckMark extends StatelessWidget {
  const _CheckMark({required this.checked});
  final bool checked;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      width: 22,
      height: 22,
      decoration: BoxDecoration(
        color: checked ? cs.primary : Colors.transparent,
        border: Border.all(
          color: checked ? cs.primary : cs.onSurface.withOpacity(0.4),
          width: 2,
        ),
        borderRadius: BorderRadius.circular(999),
      ),
      child: checked
          ? const Icon(Icons.check, size: 12, color: Colors.white)
          : null,
    );
  }
}
