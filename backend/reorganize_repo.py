#!/usr/bin/env python3
"""
CleanShot Repository Reorganizer
Safely reorganizes Phase 1 files and sets up Phase 2 backend structure.
"""

import os
import shutil
import json
from pathlib import Path
from datetime import datetime


def analyze_repo(repo_path):
    """Analyze current repo structure and identify Phase 1 files."""
    repo_path = Path(repo_path)
    
    if not repo_path.exists():
        print(f"❌ Repository not found: {repo_path}")
        return None
    
    print(f"🔍 Analyzing repository: {repo_path}")
    
    # Phase 1 files to identify and move
    phase1_files = {
        'scripts': ['folder_parser.py', 'image_filter.py', 'captioner.py', 
                   'manifest_builder.py', 'anomaly_report.py'],
        'directories': ['output'],
        'optional': ['.env', '.env.example', 'requirements.txt']
    }
    
    found_files = {}
    
    # Check what exists
    for category, files in phase1_files.items():
        found_files[category] = []
        for file in files:
            file_path = repo_path / file
            if file_path.exists():
                found_files[category].append(file)
                print(f"✅ Found {category}: {file}")
            else:
                print(f"ℹ️  Not found: {file}")
    
    # Check for credentials directory
    credentials_path = repo_path / 'credentials'
    if credentials_path.exists():
        print(f"✅ Found credentials directory")
        found_files['credentials'] = True
    else:
        print(f"⚠️  Credentials directory not found")
        found_files['credentials'] = False
    
    return found_files


def create_backup(repo_path):
    """Create a backup of the current repo state."""
    repo_path = Path(repo_path)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = repo_path.parent / f"CleanShot_backup_{timestamp}"
    
    print(f"💾 Creating backup: {backup_path}")
    shutil.copytree(repo_path, backup_path)
    
    return backup_path


def reorganize_repo(repo_path, dry_run=True):
    """
    Reorganize repository structure for Phase 2.
    
    Args:
        repo_path: Path to CleanShot repository
        dry_run: If True, only show what would be done without making changes
    """
    repo_path = Path(repo_path)
    
    # Analyze current structure
    found_files = analyze_repo(repo_path)
    if not found_files:
        return False
    
    print("\n" + "="*60)
    print("REORGANIZATION PLAN")
    print("="*60)
    
    # Plan the moves
    moves = []
    
    # Phase 1 archive directory
    phase1_dir = repo_path / 'phase1-archive'
    moves.append(('create_dir', phase1_dir))
    
    # Backend directory  
    backend_dir = repo_path / 'backend'
    moves.append(('create_dir', backend_dir))
    
    # Move Phase 1 scripts
    for script in found_files['scripts']:
        src = repo_path / script
        dst = phase1_dir / script
        moves.append(('move_file', src, dst))
    
    # Move Phase 1 directories
    for directory in found_files['directories']:
        src = repo_path / directory
        dst = phase1_dir / directory
        moves.append(('move_dir', src, dst))
    
    # Handle optional files
    for opt_file in found_files['optional']:
        src = repo_path / opt_file
        if opt_file == '.env':
            # Move .env to phase1, create new one for backend
            dst = phase1_dir / f"phase1_{opt_file}"
            moves.append(('move_file', src, dst))
        elif opt_file == '.env.example':
            # Copy to phase1, keep original for backend
            dst = phase1_dir / f"phase1_{opt_file}"
            moves.append(('copy_file', src, dst))
        elif opt_file == 'requirements.txt':
            # Move to phase1
            dst = phase1_dir / f"phase1_{opt_file}"
            moves.append(('move_file', src, dst))
    
    # Create Phase 1 README
    phase1_readme = phase1_dir / 'README.md'
    moves.append(('create_file', phase1_readme, create_phase1_readme_content()))
    
    # Print the plan
    for move in moves:
        if move[0] == 'create_dir':
            print(f"📁 Create directory: {move[1]}")
        elif move[0] == 'move_file':
            print(f"📄 Move file: {move[1]} → {move[2]}")
        elif move[0] == 'move_dir':
            print(f"📂 Move directory: {move[1]} → {move[2]}")
        elif move[0] == 'copy_file':
            print(f"📋 Copy file: {move[1]} → {move[2]}")
        elif move[0] == 'create_file':
            print(f"✍️  Create file: {move[1]}")
    
    if dry_run:
        print(f"\n⚠️  DRY RUN MODE - No changes made")
        print(f"Run with --execute to perform these operations")
        return True
    
    # Ask for confirmation
    print(f"\n❓ Execute this reorganization plan? (y/N): ", end="")
    confirm = input().strip().lower()
    
    if confirm != 'y':
        print("❌ Reorganization cancelled")
        return False
    
    # Create backup first
    backup_path = create_backup(repo_path)
    
    # Execute the plan
    print(f"\n🚀 Executing reorganization...")
    
    try:
        for move in moves:
            if move[0] == 'create_dir':
                move[1].mkdir(parents=True, exist_ok=True)
                print(f"✅ Created directory: {move[1]}")
                
            elif move[0] == 'move_file':
                if move[1].exists():
                    move[2].parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(move[1]), str(move[2]))
                    print(f"✅ Moved file: {move[1]} → {move[2]}")
                
            elif move[0] == 'move_dir':
                if move[1].exists():
                    move[2].parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(move[1]), str(move[2]))
                    print(f"✅ Moved directory: {move[1]} → {move[2]}")
                
            elif move[0] == 'copy_file':
                if move[1].exists():
                    move[2].parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(str(move[1]), str(move[2]))
                    print(f"✅ Copied file: {move[1]} → {move[2]}")
                
            elif move[0] == 'create_file':
                move[1].parent.mkdir(parents=True, exist_ok=True)
                with open(move[1], 'w') as f:
                    f.write(move[2])
                print(f"✅ Created file: {move[1]}")
        
        print(f"\n🎉 Reorganization complete!")
        print(f"💾 Backup created at: {backup_path}")
        print(f"\n📋 Next steps:")
        print(f"1. Copy your Phase 2 backend files into: {backend_dir}")
        print(f"2. Update paths in your .env file")
        print(f"3. Test that everything works")
        print(f"4. Delete backup when you're confident: {backup_path}")
        
        return True
        
    except Exception as e:
        print(f"❌ Error during reorganization: {e}")
        print(f"💾 Backup available at: {backup_path}")
        return False


def create_phase1_readme_content():
    """Generate README content for Phase 1 archive."""
    return """# CleanShot Phase 1 Archive

This directory contains the completed Phase 1 pipeline tools that prepared the forklift image dataset for Phase 2.

## What Phase 1 Accomplished

- **8,834 captioned forklift images** uploaded to `gs://cleanshot-training-df-2026`
- **Structured metadata extraction** from folder naming conventions
- **Quality filtering** for blur, resolution, duplicates
- **Automated captioning** using Anthropic Claude API
- **Dataset preparation** for AI model training and reference matching

## Files in this archive

- `folder_parser.py` — Extract metadata from folder naming conventions
- `image_filter.py` — Quality filtering and deduplication
- `captioner.py` — Automated image captioning with Claude
- `manifest_builder.py` — Generate JSONL manifests for training
- `anomaly_report.py` — Data quality reporting and validation
- `output/` — Results: caption_cache.json, folder_index.json, manifests

## Phase 1 is Complete

These tools served their purpose and the dataset is ready. Phase 2 (the backend in `../backend/`) uses the prepared dataset for reference-guided AI processing.

The valuable output from Phase 1 lives in Google Cloud Storage:
- Reference images: `gs://cleanshot-training-df-2026/`
- Metadata: `caption_cache.json` with 8,834 detailed records

---
*Generated by CleanShot repository reorganizer*
"""


def main():
    """Main entry point."""
    import argparse
    
    parser = argparse.ArgumentParser(description='Reorganize CleanShot repository for Phase 2')
    parser.add_argument('repo_path', 
                       help='Path to CleanShot repository (default: current directory)',
                       nargs='?', 
                       default='.')
    parser.add_argument('--execute', 
                       action='store_true',
                       help='Execute the reorganization (default: dry run)')
    
    args = parser.parse_args()
    
    print("🏗️  CleanShot Repository Reorganizer")
    print("="*60)
    
    success = reorganize_repo(
        repo_path=args.repo_path,
        dry_run=not args.execute
    )
    
    if success and not args.execute:
        print(f"\n💡 To execute: python reorganize_repo.py --execute")
    
    return 0 if success else 1


if __name__ == '__main__':
    exit(main())
