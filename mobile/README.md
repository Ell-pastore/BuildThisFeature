# Smart File Manager – AI File Manager (Frontend)

Flutter + Material 3 UI for an AI-powered file manager app.

## Features

- Home (Storage overview + AI tip + Quick actions + Recent files)
- Browse (Smart categories + Smart Folders)
- File List with multi-select and action toolbar
- Semantic Search
- AI Assistant chat with plan preview
- Confirmation bottom sheet
- Settings (AI & Privacy, Automation, Appearance)
- Light & Dark mode support

## Getting Started

```bash
flutter pub get
flutter run
```

## Project Structure

```
lib/
├── main.dart
├── theme/app_theme.dart
├── models/dummy_data.dart
├── widgets/common_widgets.dart
└── screens/
    ├── home_screen.dart
    ├── browse_screen.dart
    ├── file_list_screen.dart
    ├── search_screen.dart
    ├── ai_chat_screen.dart
    ├── confirm_sheet.dart
    └── settings_screen.dart
```

## Notes

- This is **UI only**. Dummy data is used.
- When backend API keys are ready, replace `DummyData` and wire the buttons to real endpoints.
- No fake status bars or phone frames are included.
