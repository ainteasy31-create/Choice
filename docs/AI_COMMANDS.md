# Pipeline AI Commands

This document defines natural-language commands that any AI assistant (or human) can use to manage the Choice Properties pipeline.

## Folder System Overview

Properties in the pipeline can be grouped into **folders** (also called "rooms" or "houses"). Each folder has a **name** and properties inside it get **auto-assigned serial numbers** (#1, #2, #3...) based on arrival order.

Example: You create a folder called "Wisdom" and add 12 properties. The first property added becomes **#1**, the second becomes **#2**, and so on.

---

## Available Commands

### Create a Folder
> "Create a folder called Wisdom"
> "Make me a room called Columbus Q3"

**Maps to:** `pipeline_folder_create(p_name: 'Wisdom')`

### List All Folders
> "Show me all my folders"
> "What folders do I have?"

**Maps to:** `pipeline_folder_list()`

Returns: folder name, description, property count, published count, archived count.

### Show Properties in a Folder
> "Show me properties in folder Wisdom"
> "What's in the Columbus folder?"

**Maps to:** `pipeline_folder_properties(p_folder_id: '<resolved from name>')`

Returns: each property with its serial number, address, rent, status, quality score.

### Add a Property to a Folder
> "Add property PP-ABC123 to folder Wisdom"
> "Put this listing in my Columbus folder"

**Maps to:** `pipeline_folder_add_property(p_property_id: 'PP-ABC123', p_folder_name: 'Wisdom')`

The system auto-assigns the next serial number.

### Remove a Property from a Folder
> "Remove property 3 from folder Wisdom"
> "Take property PP-ABC123 out of its folder"

**Maps to:** `pipeline_folder_remove_property(p_property_id: '<resolved from serial>')`

### Publish All Properties in a Folder
> "Publish everything in folder Wisdom"
> "Publish all properties in Columbus"

**Maps to:** `pipeline_folder_publish(p_folder_id: '<resolved>', p_property_ids: NULL)`

### Publish a Specific Property in a Folder
> "Publish property 3 in folder Wisdom"
> "Publish #5 in the Columbus folder"

**Maps to:**
1. Look up property by serial: `SELECT id FROM pipeline_properties WHERE folder_id = '<folder>' AND folder_serial = 3`
2. Call `pipeline_publish(p_id: '<property id>')`

### Delete a Folder
> "Delete folder Wisdom"
> "Remove the Columbus folder"

**Maps to:** `pipeline_folder_delete(p_folder_id: '<resolved>')`

**What happens:** All unpublished properties in the folder are **archived** (kept in the pipeline but hidden). Published properties are unassigned from the folder. The folder itself is deleted.

### Get Folder Stats
> "How many properties in folder Wisdom?"
> "Show me stats for Wisdom"

**Maps to:** `pipeline_folder_stats(p_folder_name: 'Wisdom')`

Returns: total, published, scraped, edited, archived counts, plus full property list with serials.

### Rename a Folder
> "Rename folder Wisdom to Wisdom2"
> "Call the Columbus folder Columbus Q4"

**Maps to:** `pipeline_folder_rename(p_folder_id: '<resolved>', p_new_name: 'Wisdom2')`

---

## How an AI Should Resolve References

When given a command like "publish property 3 in folder Wisdom":

1. **Resolve folder name → ID:**
   ```sql
   SELECT id FROM pipeline.pipeline_folders WHERE name ILIKE '%wisdom%'
   ```

2. **Resolve serial → property ID:**
   ```sql
   SELECT id FROM pipeline.pipeline_properties
   WHERE folder_id = '<folder_id>' AND folder_serial = 3
   ```

3. **Execute the action:**
   ```sql
   SELECT * FROM pipeline_publish('<property_id>', NULL)
   ```

---

## Resolving Properties Without Serials

If a property doesn't have a folder_serial, you can find it by:
- **ID** (e.g., `PP-ABC12345`)
- **Address** (e.g., "the one on 123 Main St")
- **City + rent** (e.g., "the $1500 one in Austin")

---

## ImageKit Cleanup Strategy

To keep ImageKit storage lean:

1. **When archiving a property:** Call `imagekit-delete` edge function to delete photos from ImageKit after archiving.
2. **When deleting a folder:** Properties are archived (photos preserved for potential re-publish). To purge, use the "Purge archived photos" admin action.
3. **Regular hygiene:** Run `pipeline_cleanup_orphans()` RPC to find pipeline records with no photos and clean them up.

---

## Notes for AI Assistants

- Always confirm destructive actions (delete folder, archive) with the user first
- Serial numbers are per-folder, starting at 1
- A property can only be in one folder at a time
- Properties don't need to be in a folder — folders are optional organizational tools
- The `pipeline_folder_add_property` RPC auto-creates the folder if it doesn't exist (in future versions)