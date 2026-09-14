import 'package:flutter/material.dart';

class FileItem {
  final String name;
  final String meta;
  final String type; // PDF, IMG, DOC, XLS, PPT
  final bool selected;

  const FileItem({
    required this.name,
    required this.meta,
    required this.type,
    this.selected = false,
  });
}

class CategoryItem {
  final String name;
  final String size;
  final String count;
  final Color color;
  final IconData icon;

  const CategoryItem({
    required this.name,
    required this.size,
    required this.count,
    required this.color,
    required this.icon,
  });
}

class DummyData {
  static const recentFiles = [
    FileItem(
      name: 'CS-Lecture-Notes-W3.pdf',
      meta: 'Today · 9:14 · 2.4 MB',
      type: 'PDF',
    ),
    FileItem(
      name: 'IMG_2409.heic',
      meta: 'Today · 8:02 · 3.8 MB',
      type: 'IMG',
    ),
  ];

  static const documents = [
    FileItem(
      name: 'CS-Lecture-Notes-W3.pdf',
      meta: 'Documents · 2.4 MB · Today',
      type: 'PDF',
      selected: true,
    ),
    FileItem(
      name: 'Math-HW-Solutions.pdf',
      meta: 'Documents · 1.6 MB · Yesterday',
      type: 'PDF',
      selected: true,
    ),
    FileItem(
      name: 'Group-Project-Proposal.docx',
      meta: 'Documents · 482 KB · 2 days ago',
      type: 'DOC',
    ),
    FileItem(
      name: 'Budget-Tracker-Q4.xlsx',
      meta: 'Documents · 312 KB · Last week',
      type: 'XLS',
      selected: true,
    ),
    FileItem(
      name: 'Final-Presentation.pptx',
      meta: 'Documents · 8.7 MB · 3 days ago',
      type: 'PPT',
    ),
    FileItem(
      name: 'Tax-Forms-2024.pdf',
      meta: 'Documents · 8.5 MB · Mar 12',
      type: 'PDF',
      selected: true,
    ),
    FileItem(
      name: 'Resume-Final.docx',
      meta: 'Documents · 218 KB · Feb 28',
      type: 'DOC',
    ),
  ];

  static final categories = [
    const CategoryItem(
      name: 'Documents',
      size: '26.4 GB',
      count: '142',
      color: Color(0xFFEF4444),
      icon: Icons.description_outlined,
    ),
    const CategoryItem(
      name: 'Photos',
      size: '45.2 GB',
      count: '3,847',
      color: Color(0xFF2563EB),
      icon: Icons.image_outlined,
    ),
    const CategoryItem(
      name: 'Videos',
      size: '31.6 GB',
      count: '218',
      color: Color(0xFFD97706),
      icon: Icons.play_circle_outline,
    ),
    const CategoryItem(
      name: 'Audio',
      size: '4.7 GB',
      count: '86',
      color: Color(0xFF9333EA),
      icon: Icons.music_note_outlined,
    ),
    const CategoryItem(
      name: 'APKs',
      size: '2.1 GB',
      count: '52',
      color: Color(0xFF16A34A),
      icon: Icons.android,
    ),
    const CategoryItem(
      name: 'Chats',
      size: '812 MB',
      count: '14',
      color: Color(0xFF0EA5A4),
      icon: Icons.chat_bubble_outline,
    ),
  ];
}
